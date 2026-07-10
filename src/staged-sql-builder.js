import {fhirpathToAst} from "./fhirpath-parser.js";
import {astToSql} from "./ddb-sql-builder.js";
import {assertSimplePath, jsonFold, typedSeed, repeatStructure, childElemOf, forcedFieldStructures, wrap, elemFromType} from "./repeat-lowering.js";
import {collectColumnNames} from "./view-parser.js";

// The reserved CTE names that bracket the emitter's pipeline (SPEC_sql_template_contract). The
// template binds the input relation as `_fq_input` (whose columns are the resource's elements) and
// consumes `_fq_output` (the flat, column-clean result). Surfaced to templates as the values of the
// fq_sql_input / fq_sql_output variables, so a template never types these names itself.
const INPUT_CTE = "_fq_input";
const OUTPUT_CTE = "_fq_output";
// The pipeline's root CTE: the typed projection of the input relation that the flattening stages
// chain from. `_fq_`-prefixed like the seam CTEs (SPEC_sql_template_contract §4.2) so it can never
// collide with a user column carried alongside it.
const SRC_CTE = "_fq_src";

// Staged-CTE emitter (SPEC_view_lowering). Walks the ViewDefinition tree, classifies each
// scope CHAIN (<=1 fan-out) or FORK (>=2), and emits staged CTEs. Leaves are compiled
// by the existing typed FHIRPath engine; the scope element is aliased `_node` and passed
// as the engine's outer root-var so internal `el` lambdas never collide (design D2). Every
// internal identifier is `_`-prefixed so it can never collide with a user column name (which
// must start with a letter); see the `name` helper in `buildStagedQuery`.
//
// `repeat` is the one unbounded-depth directive, so it cannot live on the typed substrate:
// the descent is performed in JSON (a `WITH RECURSIVE` CTE over a JSON node, SPEC_view_lowering §6),
// while every column/forEach/where is still evaluated typed — the recursion's JSON node is
// converted per-scope to a typed element with a lenient `from_json` bridge, and the existing leaf
// engine compiles against it unchanged. The binding mode oscillates: typed scopes read
// `read_json_auto` columns / `node`; a `repeat` scope reads `el = from_json(node)`.

// The column a repeat's from_json bridge binds its typed element to. Deliberately NOT `el`: the
// typed leaf engine names its internal `list_transform`/`list_filter` lambda parameter `el`, so a
// repeat-scope column whose path navigates through an array (e.g. `answer.value.ofType(string)`)
// would otherwise shadow the bridge element with the lambda element and bind the wrong struct. A
// distinct bridge name keeps the two separate; it is both the CTE column alias and the leaf root-var.
// The `_` prefix (which a valid VD column name can never start with) keeps it clear of user columns.
const BRIDGE_VAR = "_el_r";

// --- tree helpers ---------------------------------------------------------

// Does the ViewDefinition contain any `repeat`? (forces a leading `WITH RECURSIVE`).
function hasRepeat(node) {
	if (!node || typeof node !== "object") return false;
	if (node.repeat) return true;
	return (node.select || []).some(hasRepeat) || (node.unionAll || []).some(hasRepeat);
}

// Collect a scope's direct columns and fan-out children. A nested `select` with no
// fan-out directive is transparent: its columns and fan-outs merge into this scope.
// A `repeat` child is a fan-out classified as `{type: "repeat"}`.
function collectScope(node) {
	let columns = node.column ? [...node.column] : [];
	let fanouts = [];
	(node.select || []).forEach(child => {
		if (child.repeat) {
			fanouts.push({type: "repeat", node: child});
		} else if (child.forEach || child.forEachOrNull) {
			fanouts.push({type: "each", node: child});
		} else {
			const sub = collectScope(child);
			columns.push(...sub.columns);
			fanouts.push(...sub.fanouts);
		}
	});
	if (node.unionAll) fanouts.push({type: "union", node});
	return {columns, fanouts};
}

// Repeat seed paths declared by any repeat branch anywhere in a unionAll tree. A repeat branch
// forces its seed field to JSON[] for the whole union scope, so a sibling columns-only / forEach
// branch navigating the same field must be bridged too (issue #35).
function unionRepeatSeeds(branches) {
	return branches.flatMap(b =>
		b.repeat ? b.repeat : b.unionAll ? unionRepeatSeeds(b.unionAll) : []);
}

// Columns of every non-iterating (columns-only) branch in a unionAll tree. These compile against
// the union's parent element, so they navigate forced fields exactly as the scope's own columns do
// and must feed the same re-type structure derivation.
function unionColumnsOnlyCols(branches) {
	return branches.flatMap(b =>
		b.unionAll ? unionColumnsOnlyCols(b.unionAll)
		: (b.repeat || b.forEach || b.forEachOrNull) ? []
		: (b.column || []));
}

// Does this scope (or any descendant) contain a fork (>=2 fan-out children)?
// Memoised per node: emitScope queries it at every level (once globally, then per fan-out for
// `needsOrd`), so without the cache the recursive walk is re-run on overlapping subtrees. Keyed
// on the VD node objects, which are unique per build, so a module-level WeakMap is collision-free.
const forkCache = new WeakMap();
function subtreeHasFork(node) {
	if (forkCache.has(node)) return forkCache.get(node);
	const {fanouts} = collectScope(node);
	const result = fanouts.length >= 2
		|| fanouts.some(f => (f.type === "each" || f.type === "repeat") && subtreeHasFork(f.node));
	forkCache.set(node, result);
	return result;
}

// Does a scope reference `%rowIndex` in a column it binds itself? The candidate set is the scope's
// own (direct + transparently-merged) columns and any columns-only `unionAll` branch (which
// materialises into this stage); a nested forEach/repeat or an iterating union branch opens its own
// scope and is excluded. `colHit(col)` decides whether a single column mentions `%rowIndex` — there
// are two detectors (see below) sharing this one traversal so the "opens its own scope" rule lives
// in a single place.
function scopeMentionsRowIndex(node, colHit) {
	const {columns, fanouts} = collectScope(node);
	if (columns.some(colHit)) return true;
	return fanouts.filter(f => f.type === "union")
		.some(f => unionColsMentionRowIndex(f.node.unionAll, colHit));
}
function unionColsMentionRowIndex(branches, colHit) {
	return branches.some(b => {
		if (b.unionAll) return unionColsMentionRowIndex(b.unionAll, colHit);
		if (b.forEach || b.forEachOrNull || b.repeat) return false; // opens its own scope
		return (b.column || []).some(colHit);
	});
}

// Raw-string `%rowIndex` detection, used ONLY for the structural look-ahead that forces a partition
// key down a spine to a `%rowIndex` repeat (Stage 4). Over-approximation is safe here: a false
// positive can only force an extra, harmless carried key, never alter a `%rowIndex`-free view (which
// contains no `%rowIndex` token to match). The precise per-scope binding decision still parses the
// resolved AST when the column is compiled (see `scopeUsesRowIndex`), so this raw scan never affects
// which value is emitted.
function pathMentionsRowIndex(p) {
	return typeof p === "string" && /%rowIndex\b/.test(p);
}
const colMentionsRowIndex = c => pathMentionsRowIndex(c.path || c.name);
const repeatScopeUsesRowIndex = repeatNode => scopeMentionsRowIndex(repeatNode, colMentionsRowIndex);

// Does any `repeat` anywhere in `node`'s subtree have a body that references `%rowIndex`? A
// `%rowIndex` repeat assigns its index by a window partitioned by its enclosing-scope instance, so
// the resource key (`_rid`) and any enclosing iterating step's ordinal must be minted on the spine
// down to that repeat. Forces the root key and carried ordinals even in a fork-free view. Memoised
// like `subtreeHasFork` — emitScope queries it per fan-out as it descends overlapping subtrees.
const repeatRowIndexCache = new WeakMap();
function subtreeHasRepeatUsingRowIndex(node) {
	if (!node || typeof node !== "object") return false;
	if (repeatRowIndexCache.has(node)) return repeatRowIndexCache.get(node);
	const result = (node.repeat && repeatScopeUsesRowIndex(node))
		|| (node.select || []).some(subtreeHasRepeatUsingRowIndex)
		|| (node.unionAll || []).some(subtreeHasRepeatUsingRowIndex);
	repeatRowIndexCache.set(node, result);
	return result;
}

// Deep-walk a FHIRPath AST (nested arrays of segments, each with possible `args`/`type` sub-trees)
// for the contextual `%rowIndex` segment emitted by the front end. Used to decide precisely, before
// a repeat's columns are compiled, whether its scope binds `%rowIndex`. The AST is a finite tree.
function astHasRowIndex(node) {
	if (Array.isArray(node)) return node.some(astHasRowIndex);
	if (node && typeof node === "object") {
		if (node.segmentType === "rowIndex") return true;
		return Object.values(node).some(astHasRowIndex);
	}
	return false;
}

// VD column names in document (tree) order, deduped — the output projection contract.
function columnOrder(node) {
	const names = collectColumnNames(node);
	return names.filter((n, i) => names.indexOf(n) === i);
}

// --- leaf compilation (reuses the typed engine) ---------------------------

export function makeBuilder(schema, vars) {

	// `elem.rowIndexSql` is the SQL the current scope binds `%rowIndex` to: the per-iteration
	// ordinal of the enclosing forEach/forEachOrNull (0-based), or "0" at the resource root / a
	// non-iterating scope. Threaded into the leaf engine so a `%rowIndex` leaf resolves to it.
	function compilePath(pathStr, elem) {
		const ast = fhirpathToAst(pathStr, elem.seed, schema, vars);
		const out = astToSql(ast, elem.inLambda, elem.inputType, elem.ref || "el", elem.rowIndexSql);
		return {sql: out.sql, outputType: out.outputType, type: ast.type};
	}

	// `retype` (field name -> from_json cast macro), when present, re-types fields a sibling `repeat`
	// forced to raw JSON[] so a column navigating them yields its declared type (issue #35). It rides
	// on the element's inputType so the leaf engine wraps only the first nav off the element.
	function compileColumn(col, elem, retype) {
		const pathExpr = col.path || col.name;
		const fpStr = `_col${col.collection ? "_collection" : ""}('${col.name}', ${pathExpr})`;
		const ast = fhirpathToAst(fpStr, elem.seed, schema, vars);
		const inputType = retype ? {...elem.inputType, _retype: retype} : elem.inputType;
		const out = astToSql(ast, elem.inLambda, inputType, elem.ref || "el", elem.rowIndexSql);
		const expr = out.sql.replace(new RegExp(`^'${col.name}':\\s*`), "");
		return {name: col.name, expr, sql: `${expr} AS ${col.name}`};
	}

	// Prepare a fan-out over `pathStr` from `elem` in a single compile pass, returning both the
	// array SQL to UNNEST and the child scope element.
	function prepareFanout(pathStr, elem) {
		const {sql, outputType, type} = compilePath(pathStr, elem);
		return {
			arrSql: wrap(sql, outputType.isArray),
			childElem: elemFromType(type)
		};
	}

	const builder = {compilePath, compileColumn, prepareFanout};
	builder.childElemOf = (pathStr, elem) => childElemOf(pathStr, elem, builder);
	builder.repeatStructure = (repeatNode, elemSchemaPath) => repeatStructure(repeatNode, elemSchemaPath, schema, vars);
	return builder;
}

// --- main entry -----------------------------------------------------------

export function buildStagedQuery(vd, schema, vars, opts = {}) {
	const B = makeBuilder(schema, vars);

	const rootKeyMode = opts.rootKey || "natural";
	if (rootKeyMode !== "natural" && rootKeyMode !== "uuid")
		throw new Error(`unknown rootKey mode: ${rootKeyMode} (expected "natural" or "uuid")`);

	const ctes = [];
	let counter = 0;
	// Every generated relation/column name is `_`-prefixed. A valid VD column name must start with a
	// letter (view-parser enforces `^[A-Za-z][A-Za-z0-9_]*$`), so a leading `_` guarantees no internal
	// identifier can ever collide with a user column carried in the same CTE. The fixed internal names
	// minted outside this helper (`_rid`, `_ord{N}`, `_nord{N}`, `_node`, `_ord`, `_path`, BRIDGE_VAR)
	// follow the same rule.
	const name = (base) => `_${base}_${++counter}`;

	const viewHasRepeat = hasRepeat(vd);
	const viewHasFork = subtreeHasFork(vd);
	// A `%rowIndex` repeat partitions its pre-order window by its enclosing-scope instance, so it
	// needs a per-resource partition key even when the view has no fork — force the root `_rid`
	// whenever any repeat below uses `%rowIndex` (Stage 4), in addition to the fork case.
	const viewHasRepeatRowIndex = subtreeHasRepeatUsingRowIndex(vd);
	const forceRootKey = viewHasFork || viewHasRepeatRowIndex;
	const rootKey = forceRootKey ? ["_rid"] : [];

	// Cast macros: each distinct `from_json` structure becomes one `fq_cast_*` macro emitted in
	// the preamble; identical structures (e.g. a repeat's single canonical descent type) share a
	// macro, so a recursion that visits the same element type at every level pools to one macro.
	const macroByStructure = new Map();
	const macroDefs = [];
	function castMacroFor(structure, schemaPath) {
		if (macroByStructure.has(structure)) return macroByStructure.get(structure);
		const base = "fq_cast_" + String(schemaPath || "x").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
		const used = new Set(macroByStructure.values());
		let nm = base, i = 1;
		while (used.has(nm)) nm = `${base}_${++i}`;
		macroByStructure.set(structure, nm);
		macroDefs.push(`CREATE OR REPLACE MACRO ${nm}(j) AS from_json(j, '${structure}');`);
		return nm;
	}

	// A forced-field-structures map (relative path -> typed STRUCT) lowered to an inline re-type map
	// (relative path -> from_json cast macro), keyed off `elem` so the cast applies at the right depth.
	// Shared by the per-scope column re-type (issue #35) and the resource-root where-path re-type.
	function buildRetypeMap(structs, elem) {
		const map = {};
		for (const [path, struct] of structs)
			map[path] = castMacroFor(struct, B.childElemOf(path, elem).seed);
		return map;
	}

	// Repeat seed fields that must be forced to JSON[] in the typed read schema even when a
	// sibling navigation would otherwise type them ("repeat wins").
	const forcedJsonPaths = [];

	// The root `_rid` is the recombination key for any root fork. In "natural" mode it is the
	// resource key, sourced from `getResourceKey()`. In "uuid" mode it is a synthesised per-resource
	// `uuid()` that requires no id-uniqueness assumption, but whose volatility means `_fq_src` must be
	// materialised so both fork branches (and a repeat's recursive descent) observe the same value.
	const rootKeyExpr = rootKeyMode === "uuid"
		? "uuid()"
		: B.compilePath("getResourceKey()", {ref: null, inLambda: false, seed: vd.resource, inputType: {}}).sql;
	// Natural-key mode reads the resource key, which the ViewDefinition need not otherwise
	// reference; expose its AST so the caller can add it to the typed read schema. Lazy: only
	// when a fork actually needs the key (chain-only views and "uuid" mode add nothing).
	const resourceKeyAst = (forceRootKey && rootKeyMode === "natural")
		? fhirpathToAst("getResourceKey()", vd.resource, schema, vars)
		: null;
	// "uuid()" is volatile: the source scope must be materialised so it is evaluated exactly
	// once per resource and all branches (and a repeat's recursive descent) join on the same key.
	const srcMaterialized = forceRootKey && rootKeyMode === "uuid";

	// The typed element produced by a from_json bridge over a JSON node column (bound as BRIDGE_VAR).
	// `rowIndexSql: null` by default — a repeat's own descent scope has no positional ordinal unless
	// its body actually references `%rowIndex` (Stage 4), in which case `emitRepeat` rebinds it to the
	// pre-order window column. Left null, a stray `%rowIndex` leaf is rejected rather than silently
	// bound to a constant. A forEach/forEachOrNull *inside* a repeat body rebinds it to its ordinal.
	function bridgeElem(seed) {
		return {ref: BRIDGE_VAR, inLambda: true, seed, inputType: {fhirType: "BackboneElement", isArray: false, schemaPath: seed}, rowIndexSql: null};
	}

	// Does a scope bound against `elem` reference `%rowIndex`? The precise binding decision: parse
	// each candidate column (cheap at build time) and look for the contextual segment, rather than
	// pattern-matching the raw string. Reuses the shared `scopeMentionsRowIndex` traversal (same
	// "opens its own scope" rule as the raw look-ahead) with an AST-based per-column predicate.
	const scopeUsesRowIndex = (node, elem) =>
		scopeMentionsRowIndex(node, c => astHasRowIndex(fhirpathToAst(c.path || c.name, elem.seed, schema, vars)));

	// Prepare a repeat fan-out: validate its paths, resolve the descent element type, and
	// materialise the seed array into the owning stage's projection. The seed fields are forced to
	// JSON[] in the read schema by `emitScope` (the single place that does so), not here.
	function prepRepeat(f, elem, stageSelect) {
		f.listedPaths = f.node.repeat;
		f.listedPaths.forEach(assertSimplePath);
		f.childElem = B.childElemOf(f.listedPaths[0], elem);
		f.seedCol = name("a") + "_seed";
		stageSelect.push(`${typedSeed(f.listedPaths, elem, B)} AS ${f.seedCol}`);
		// Does the repeat body bind `%rowIndex`? Parse against the typed bridge element it will be
		// evaluated under — drives the pre-order path + window in `emitRepeat` (Stage 4).
		f.usesRowIndex = scopeUsesRowIndex(f.node, bridgeElem(f.childElem.seed));
	}

	// Emit a repeat's JSON descent + typed bridge, then continue the body scope on the typed
	// element `el`. `parentRel` exposes the materialised seed column + the carried/key columns.
	// (The descent CTE MUST live under a leading `WITH RECURSIVE`, set up by the caller — a
	// recursive CTE under a plain `WITH` errors as `Catalog Error: Table 'rep' does not exist`.)
	// `keepKey` is forwarded to the body scope so that, when the repeat is itself a fork branch,
	// the body's result relation physically exposes `keyCols` for the enclosing fork to rejoin on.
	function emitRepeat(f, parentRel, carried, keyCols, keepKey) {
		const carryCols = [...keyCols, ...carried];
		const carryProj = (rel) => carryCols.map(c => `${rel}.${c}`);
		const lead = (cols) => cols.length ? cols.join(", ") + ", " : "";

		// A repeat assigns a deterministic pre-order index over its descent by carrying an integer
		// descent `path` (the per-level `WITH ORDINALITY` ordinals from the seed to a node) through
		// both legs, then ranking with `row_number() OVER (PARTITION BY {enclosing-scope key} ORDER BY
		// path)`. Ordering the `BIGINT[]` path element-wise gives depth-first pre-order
		// (`[1] < [1,1] < [1,2] < [2]`); the index is unique per visited node and assigned at the
		// repeat's OWN scope (one row per node), before any fork recombination. That single window
		// serves up to three roles, so it is computed whenever ANY of them is needed:
		//   - needNodeKey: a forking repeat body needs a per-node identity carried as an extra key, or
		//     its fork branches would `JOIN USING(keyCols)` and cross-product across ALL nodes;
		//   - usesRowIndex: the body binds `%rowIndex` to this index (Stage 4), materialised as a
		//     scalar that survives any later fork join;
		//   - innerNeedsOuterRn: a nested `%rowIndex` repeat needs THIS repeat's index as its window
		//     partition surrogate (so repeat-in-repeat chains via `(rid, outer_rn)`, never a LIST).
		const needNodeKey = subtreeHasFork(f.node);
		const innerNeedsOuterRn = (f.node.select || []).some(subtreeHasRepeatUsingRowIndex)
			|| (f.node.unionAll || []).some(subtreeHasRepeatUsingRowIndex);
		const needRn = needNodeKey || f.usesRowIndex || innerNeedsOuterRn;

		const repName = name("rep");
		const seedPath = needRn ? `[_ord]::BIGINT[] AS _path, ` : "";
		const recPath = needRn ? `list_append(${repName}._path, _ord), ` : "";
		const seedOrd = needRn ? ` WITH ORDINALITY AS _s(_node, _ord)` : ` AS _s(_node)`;
		const recOrd = needRn ? ` WITH ORDINALITY AS _r(_node, _ord)` : ` AS _r(_node)`;
		const seedLeg = `SELECT ${lead(carryProj(parentRel))}${seedPath}_s._node AS _node\n    FROM ${parentRel}, UNNEST(${parentRel}.${f.seedCol})${seedOrd}`;
		const recLeg = `SELECT ${lead(carryProj(repName))}${recPath}_r._node\n    FROM ${repName}, UNNEST(${jsonFold(f.listedPaths, `${repName}._node`)})${recOrd}`;
		ctes.push(`${repName} AS (\n    ${seedLeg}\n    UNION ALL\n    ${recLeg}\n  )`);

		// The descent visits a single canonical element type; convert each visited JSON node to a
		// typed element with the pooled `from_json` cast macro, then continue the body scope typed.
		const structure = B.repeatStructure(f.node, f.childElem.seed);
		const cast = `${castMacroFor(structure, f.childElem.seed)}(_node)`;
		const bridge = name("repb");
		const bodyElem = bridgeElem(f.childElem.seed);
		let bodyKeyCols = keyCols;
		if (needRn) {
			// `ORDER BY path` is a total, deterministic order within the partition (paths are unique per
			// node), so the index is reproducible across every reference to the bridge — no MATERIALIZED
			// needed. When a fork or a nested `%rowIndex` repeat needs the index as a key, `keyCols`
			// always includes the resource key (both force the root key), so the partition is per-resource.
			const rnCol = `_nord${keyCols.length}`;
			const part = keyCols.length ? `PARTITION BY ${keyCols.join(", ")} ` : "";
			const rn = `(row_number() OVER (${part}ORDER BY _path) - 1)::INTEGER AS ${rnCol}`;
			ctes.push(`${bridge} AS (\n  SELECT ${lead(carryCols)}${rn}, ${cast} AS ${BRIDGE_VAR}\n  FROM ${repName}\n)`);
			if (f.usesRowIndex) bodyElem.rowIndexSql = rnCol;             // this repeat's own %rowIndex
			// Carry the index as a key when a fork below recombines on it, or a nested `%rowIndex`
			// repeat partitions by it. (A pure-`%rowIndex` repeat with no fork/nested-repeat below
			// reads the index in its immediate body and need not carry it as a key.)
			if (needNodeKey || innerNeedsOuterRn) bodyKeyCols = [...keyCols, rnCol];
		} else {
			ctes.push(`${bridge} AS (\n  SELECT ${lead(carryCols)}${cast} AS ${BRIDGE_VAR}\n  FROM ${repName}\n)`);
		}

		// The body of a repeat is evaluated typed (its element is the from_json bridge); nested
		// repeat seeds arrive as `<bridge>.<field>` JSON[] and re-enter `WITH RECURSIVE`.
		return emitScope(f.node, bodyElem, carried, bodyKeyCols, bridge, false, null, keepKey);
	}

	// A `forEach` over a field that a sibling `repeat` forces to JSON[] (the shared-field case):
	// unnest the JSON list and consume each node through the same from_json typed bridge a repeat
	// scope uses — no recursion, just one descent level. `forkOrd`, when set, carries the iteration
	// ordinal forward as a recombination key (a fork below needs it); otherwise a private ordinal
	// supplies this iteration's `%rowIndex` only.
	function emitJsonEach(f, parentRel, carried, keyCols, forkOrd, keepKey) {
		// Mint an ordinal as a carried fork key (`forkOrd`) or when this scope binds `%rowIndex`;
		// otherwise emit none. unnestFrom binds the 0-based `%rowIndex` SQL onto
		// `f.childElem.rowIndexSql` from it (left null when no ordinal is emitted).
		const ordName = forkOrd || ((f.needsOrd || f.usesRi) ? name("rn") : null);
		const childKey = forkOrd ? [...keyCols, ordName] : keyCols;
		const from = unnestFrom(parentRel, f, ordName);
		const structure = B.repeatStructure(f.node, f.childElem.seed);
		const cast = `${castMacroFor(structure, f.childElem.seed)}(_node)`;
		const bridge = name("repb");
		// Project the body element plus, when this scope reads `%rowIndex`, the iteration's index
		// value (the raw ordinal is out of scope past this CTE when private). No index, no column.
		const rnCol = f.childElem.rowIndexSql ? name("jern") : null;
		const rnProj = rnCol ? `${f.childElem.rowIndexSql} AS ${rnCol}, ` : "";
		const carryCols = [...childKey, ...carried];
		ctes.push(`${bridge} AS (\n  SELECT ${carryCols.length ? carryCols.join(", ") + ", " : ""}${rnProj}${cast} AS ${BRIDGE_VAR}\n  FROM ${from}\n)`);
		const bodyElem = bridgeElem(f.childElem.seed);
		bodyElem.rowIndexSql = rnCol;
		return emitScope(f.node, bodyElem, carried, childKey, bridge, false, null, keepKey);
	}

	// emitScope: builds a stage exposing keyCols + carried + this scope's columns, then
	// chains or forks. `fromSql` is the FROM clause for this stage (null at root: the stage is
	// `_fq_src`; its select list is exposed as `emitScope.srcSelect` and the assembly wraps it as
	// `_fq_src AS (SELECT … FROM _fq_input)`). `schemaPrefix` (typed scopes only)
	// is the resource-rooted field path used to mark forced-JSON repeat seeds. `keepKey` requests that
	// this scope's result relation expose `keyCols` physically so an enclosing fork can rejoin on it —
	// set only when this scope is itself a fork branch (a stage already carries its key; a fork drops
	// it by default, so a non-branch fork stays byte-for-byte unchanged). Returns {rel, cols}.
	function emitScope(scopeNode, elem, carried, keyCols, fromSql, isRoot, schemaPrefix, keepKey) {
		const {columns, fanouts} = collectScope(scopeNode);

		const realFanouts = fanouts.filter(f => f.type === "each");
		const repeatFanouts = fanouts.filter(f => f.type === "repeat");
		const unionFanouts = fanouts.filter(f => f.type === "union");
		const total = realFanouts.length + repeatFanouts.length + unionFanouts.length;

		const repeatSeedFields = new Set(repeatFanouts.flatMap(f => f.node.repeat));

		// Fields forced to raw JSON[] at THIS element by any sibling `repeat` — its own repeat
		// fan-outs plus any repeat branch inside a sibling unionAll (which shares this element).
		// Relative dot paths off the element; may be multi-segment (e.g. `answer.item`, a
		// QuestionnaireResponse recursion seed). This ONE set drives the read schema, the inline
		// re-type AND the forEach fan-out mode, so the three can never disagree about which fields are
		// physically JSON.
		const forcedSeeds = new Set([
			...repeatSeedFields,
			...unionFanouts.flatMap(f => unionRepeatSeeds(f.node.unionAll))
		]);

		// A `forEach` whose field any sibling `repeat` forces to JSON[] must read it via the from_json
		// bridge rather than as a typed struct array (shared-field case). Derived from `forcedSeeds`, so
		// a field a sibling unionAll's `repeat` forces routes through the bridge just like one this
		// scope's own `repeat` forces.
		realFanouts.forEach(f => { f.jsonMode = forcedSeeds.has(f.node.forEach || f.node.forEachOrNull); });

		// "repeat wins": force each seed field to JSON[] in the typed read schema. Gated on the typed
		// spine (schemaPrefix set) — fork/repeat-body scopes read materialised arrays, not source
		// columns, so they neither force the schema nor re-type. This is the sole place seeds are
		// pushed (prepRepeat no longer does), keeping `forcedJsonPaths` the single source of truth.
		if (schemaPrefix) forcedSeeds.forEach(p =>
			forcedJsonPaths.push([...schemaPrefix, ...p.split(".")].join(".")));

		// A column navigating a forced field would emit JSON into its declared type; re-type it inline
		// at the navigation step (issue #35). The cast macro is keyed by the path RELATIVE to the
		// element, so the leaf engine applies it at the exact divergence depth — multi-segment seeds
		// included. Fields no column navigates yield no structure, so a scope with no such column
		// compiles byte-for-byte as before (retypeMap stays null).
		let retypeMap = null;
		if (schemaPrefix && forcedSeeds.size) {
			const navCols = [...columns, ...unionFanouts.flatMap(f => unionColumnsOnlyCols(f.node.unionAll))];
			const structs = forcedFieldStructures(navCols, elem.seed, [...forcedSeeds], schema, vars);
			if (structs.size) retypeMap = buildRetypeMap(structs, elem);
		}

		const colProjs = columns.map(c => B.compileColumn(c, elem, retypeMap));
		const carriedAfter = [...carried, ...colProjs.map(c => c.name)];

		// the root stage defines the resource key; deeper stages carry it forward
		const keyProj = isRoot
			? keyCols.map(k => k === "_rid" ? `${rootKeyExpr} AS _rid` : k)
			: keyCols;
		const stageSelect = [...keyProj, ...carried, ...colProjs.map(c => c.sql)];

		// materialise the array for each fan-out child as a named column in this stage
		realFanouts.forEach(f => {
			const path = f.node.forEach || f.node.forEachOrNull;
			const {arrSql, childElem} = B.prepareFanout(path, elem);
			f.arrCol = name("a") + "_arr";
			f.orNull = !!f.node.forEachOrNull;
			f.childElem = childElem;
			// Carry this iteration's ordinal forward as a recombination KEY when a fork below needs it,
			// or a `%rowIndex` repeat below needs it as a per-instance window partition surrogate (so a
			// repeat nested under a forEach restarts its pre-order index per enclosing element). Either
			// way the child key gains `ord{N}`; otherwise the ordinal is private (just this scope's
			// `%rowIndex`). The enclosing forEach's own `%rowIndex` binding is unchanged.
			f.needsOrd = subtreeHasFork(f.node) || subtreeHasRepeatUsingRowIndex(f.node);
			// Whether this scope binds `%rowIndex` to its own iteration ordinal. Together with
			// `needsOrd` this gates `WITH ORDINALITY`: when both are false, no fork or nested
			// `%rowIndex` repeat below needs the ordinal as a key and no column here reads it, so the
			// unnest emits no ordinal at all (the ordinal is otherwise free, but not free of cost).
			f.usesRi = scopeUsesRowIndex(f.node, f.childElem);
			stageSelect.push(`${arrSql} AS ${f.arrCol}`);
		});
		// materialise each repeat's seed array (the JSON descent reads from it)
		repeatFanouts.forEach(f => prepRepeat(f, elem, stageSelect));
		// materialise arrays needed by unionAll branches
		unionFanouts.forEach(f => {
			f.prepared = prepUnion(f.node.unionAll, elem, stageSelect, retypeMap, forcedSeeds);
		});

		let relName;
		if (isRoot) {
			relName = SRC_CTE;
			emitScope.srcSelect = stageSelect.join(",\n         ");
		} else {
			relName = name("s");
			ctes.push(`${relName} AS (\n  SELECT ${stageSelect.join(",\n         ")}\n  FROM ${fromSql}\n)`);
		}

		if (total === 0) return {rel: relName, cols: carriedAfter};

		if (total === 1) {
			// CHAIN
			if (realFanouts.length === 1) {
				const f = realFanouts[0];
				// A fork-key ordinal (`_ord{depth}`, carried as a key column) doubles as this
				// iteration's `%rowIndex` source; otherwise a private ordinal supplies it, but only
				// when this scope actually reads `%rowIndex` — else no ordinal is emitted.
				if (f.jsonMode) return emitJsonEach(f, relName, carriedAfter, keyCols, f.needsOrd ? `_ord${keyCols.length}` : null, keepKey);
				const ordName = f.needsOrd ? `_ord${keyCols.length}` : (f.usesRi ? name("rn") : null);
				const childKey = f.needsOrd ? [...keyCols, ordName] : keyCols;
				const from = unnestFrom(relName, f, ordName);
				const childPrefix = schemaPrefix ? [...schemaPrefix, ...(f.node.forEach || f.node.forEachOrNull).split(".")] : null;
				return emitScope(f.node, f.childElem, carriedAfter, childKey, from, false, childPrefix, keepKey);
			}
			if (repeatFanouts.length === 1) {
				// A lone `repeat` is a CHAIN: carry the scope scalars through the rCTE, no key. Forward
				// this scope's `keepKey` so a forking repeat body reached via the chain still exposes
				// `keyCols` when the chain originates from an enclosing fork branch.
				return emitRepeat(repeatFanouts[0], relName, carriedAfter, keyCols, keepKey);
			}
			// sole unionAll
			return emitUnion(unionFanouts[0].prepared, relName, carriedAfter, keyCols);
		}

		// FORK
		const branches = [];
		realFanouts.forEach(f => {
			if (f.jsonMode) {
				// A JSON-bridge branch that contains a nested fork must carry its iteration ordinal as a
				// recombination key, or the nested fork recombines on the parent key alone and cross-joins
				// across this branch's iterations (mirrors the CHAIN path's `forkOrd`).
				const br = emitJsonEach(f, relName, [], keyCols, f.needsOrd ? `_ord${keyCols.length}` : null, true);
				branches.push({rel: br.rel, cols: br.cols, kind: f.orNull ? "LEFT" : "INNER"});
				return;
			}
			// The branch recombines with its siblings on the parent `keyCols`. When it contains a nested
			// fork (or a `%rowIndex` repeat) its own iteration ordinal must additionally join the branch's
			// INTERNAL key, exactly as the CHAIN path does; otherwise the ordinal is a private `%rowIndex`
			// source only. The extra `_ord{N}` is not in the branch's returned `cols`, so its duplicate
			// name across sibling branches is never referenced by the outer recombination.
			const ordName = f.needsOrd ? `_ord${keyCols.length}` : (f.usesRi ? name("rn") : null);
			const childKey = f.needsOrd ? [...keyCols, ordName] : keyCols;
			const from = unnestFrom(relName, f, ordName);
			const br = emitScope(f.node, f.childElem, [], childKey, from, false, null, true);
			branches.push({rel: br.rel, cols: br.cols, kind: f.orNull ? "LEFT" : "INNER"});
		});
		repeatFanouts.forEach(f => {
			// A `repeat` beside >=1 other fan-out is a FORK branch: carry the fork key through the
			// rCTE and recombine on it (repeat branches are always independent fan-outs, INNER).
			// `keepKey` is true so a forking repeat body exposes `keyCols` for this fork's rejoin.
			const br = emitRepeat(f, relName, [], keyCols, true);
			branches.push({rel: br.rel, cols: br.cols, kind: "INNER"});
		});
		unionFanouts.forEach(f => {
			const br = emitUnion(f.prepared, relName, [], keyCols);
			branches.push({rel: br.rel, cols: br.cols, kind: "INNER"});
		});

		const forkName = name("f");
		// When this fork is itself a branch of an enclosing fork, expose `keyCols` in the result so the
		// outer recombination can `JOIN … USING (keyCols)`; the USING joins below make each key column
		// unambiguous. `keyCols` stays out of the returned `cols` (body columns only), so a duplicate
		// name across sibling branches is never referenced. A non-branch fork emits no key columns.
		const sel = [
			...(keepKey ? keyCols : []),
			...carriedAfter.map(c => `${relName}.${c}`),
			...branches.flatMap(b => b.cols.map(c => `${b.rel}.${c}`))
		];
		let from = relName;
		branches.forEach(b => {
			from += `\n  ${b.kind === "LEFT" ? "LEFT JOIN" : "JOIN"} ${b.rel} USING (${keyCols.join(", ")})`;
		});
		ctes.push(`${forkName} AS (\n  SELECT ${sel.join(",\n         ")}\n  FROM ${from}\n)`);
		return {rel: forkName, cols: [...carriedAfter, ...branches.flatMap(b => b.cols)]};
	}

	// A FROM clause that unnests a materialised array column of `rel`, binding each element to a
	// `node` column under `alias`. `orNull` chooses LEFT JOIN ... ON TRUE (keep parent rows with an
	// empty array) vs an inner comma-join; `ordName`, when set, adds WITH ORDINALITY as a second
	// bound column. Single source of this clause for both chains/forks and unionAll branches.
	function unnestClause(rel, arrCol, alias, orNull, ordName) {
		const tuple = ordName ? `${alias}(_node, ${ordName})` : `${alias}(_node)`;
		const ordinality = ordName ? " WITH ORDINALITY" : "";
		return orNull
			? `${rel}\n  LEFT JOIN UNNEST(${rel}.${arrCol})${ordinality} AS ${tuple} ON TRUE`
			: `${rel}, UNNEST(${rel}.${arrCol})${ordinality} AS ${tuple}`;
	}

	// Bind this fan-out's `%rowIndex` for the child scope: the 1-based UNNEST ordinal `ordName`
	// minus 1 (0-based, per SoF). For a `forEachOrNull` whose collection is empty, the LEFT JOIN
	// supplies one row whose ordinal is NULL — the official fixture wants `%rowIndex = 0` there (the
	// position of the single produced row), so coalesce the missing ordinal to 1 before subtracting.
	// Resolved in the child stage, where the ordinal column is in scope. Cast to INTEGER: `WITH
	// ORDINALITY` yields a BIGINT, but `%rowIndex` is a FHIR `integer`.
	function bindRowIndex(f, ordName) {
		// No ordinal was emitted (nothing below needs it): leave `%rowIndex` unbound so a stray
		// reference is rejected rather than silently wrong, matching a repeat's no-ordinal default.
		if (!ordName) { f.childElem.rowIndexSql = null; return; }
		const ord = f.orNull ? `COALESCE(${ordName}, 1)` : ordName;
		f.childElem.rowIndexSql = `CAST(${ord} - 1 AS INTEGER)`;
	}

	// Build a FROM clause that unnests a materialised array column of `relName` with `WITH
	// ORDINALITY`, binding the ordinal as `ordName`, and bind the child scope's `%rowIndex` to it.
	// Single source for chain, fork, and unionAll fan-outs.
	function unnestFrom(relName, f, ordName) {
		bindRowIndex(f, ordName);
		return unnestClause(relName, f.arrCol, `_u${++counter}`, f.orNull, ordName);
	}

	// --- unionAll ----------------------------------------------------------
	// prepUnion materialises each branch's forEach array (or repeat seed) into the owning
	// stage and returns a tree describing how to emit the branch pipelines.
	// `retype` re-types forced-JSON fields for columns-only branches (they share the union's parent
	// element, issue #35); `forcedSeeds` is the set of fields a sibling repeat forces, used to route a
	// forEach branch over such a field through the from_json bridge (jsonMode), like emitScope does.
	function prepUnion(unionBranches, elem, stageSelect, retype, forcedSeeds) {
		return unionBranches.map(b => {
			if (b.unionAll) return {nested: prepUnion(b.unionAll, elem, stageSelect, retype, forcedSeeds)};
			if (b.repeat) {
				const f = {node: b};
				prepRepeat(f, elem, stageSelect);
				return {repeat: f};
			}
			if (b.forEach || b.forEachOrNull) {
				const path = b.forEach || b.forEachOrNull;
				const jsonMode = !!(forcedSeeds && forcedSeeds.has(path));
				// A forEach branch over a repeat-forced field is bridged in emitUnion (jsonMode); its
				// element array is still materialised here so the bridge can unnest it.
				const {arrSql, childElem} = B.prepareFanout(path, elem);
				const arrCol = name("u") + "_arr";
				stageSelect.push(`${arrSql} AS ${arrCol}`);
				// Gate WITH ORDINALITY for this branch the same way `emitScope` does for chain/fork
				// fan-outs: `usesRi` when a column in the branch reads `%rowIndex` (resets per branch),
				// `needsOrd` when a fork or `%rowIndex` repeat below needs the ordinal. Without these
				// the `emitJsonEach`/`unnestFrom` gate reads `undefined` and never mints the ordinal,
				// leaving a `%rowIndex`-reading branch unbound. The branch ordinal is never a
				// recombination key (branches recombine on the parent `keyCols`), so it stays private.
				const needsOrd = subtreeHasFork(b) || subtreeHasRepeatUsingRowIndex(b);
				const usesRi = scopeUsesRowIndex(b, childElem);
				return {node: b, arrCol, orNull: !!b.forEachOrNull, childElem, jsonMode, needsOrd, usesRi};
			}
			// columns only (no iteration): materialise each column expr in the stage
			// (the scope element is available there but not carried downstream)
			const cols = (b.column || []).map(c => {
				const {expr, name: cn} = B.compileColumn(c, elem, retype);
				const matcol = name("uc") + "_" + cn;
				stageSelect.push(`${expr} AS ${matcol}`);
				return {name: cn, matcol};
			});
			return {cols};
		});
	}

	function emitUnion(prepared, relName, carried, keyCols) {
		const parts = [];
		let cols = null;
		// A bridged branch (a repeat's JSON descent, or a forEach over a repeat-forced field) selects
		// its body columns — keyed and carried — from the relation the bridge produced.
		const pushBridged = (br) => {
			const bodyCols = br.cols.slice(carried.length);
			cols = cols || bodyCols;
			parts.push(`SELECT ${[...keyCols, ...carried, ...bodyCols].join(", ")} FROM ${br.rel}`);
		};
		const collect = (entries, srcRel) => {
			entries.forEach(e => {
				if (e.nested) { collect(e.nested, srcRel); return; }
				if (e.repeat) {
					// a repeat branch: descend in JSON, then select its body columns keyed/carried
					pushBridged(emitRepeat(e.repeat, srcRel, carried, keyCols));
				} else if (e.arrCol) {
					if (e.jsonMode) {
						// forEach branch over a repeat-forced field: consume each element through the same
						// from_json typed bridge a sibling forEach/repeat uses, so its columns share the
						// repeat branch's physical types and the UNION ALL reconciles (issue #35).
						pushBridged(emitJsonEach(e, srcRel, carried, keyCols, null));
					} else {
						// Each iterating unionAll branch gets its own `%rowIndex` ordinal (resets per
						// branch), exactly like a forEach/forEachOrNull elsewhere — minted only when the
						// branch reads `%rowIndex` or needs the ordinal below, else a plain UNNEST.
						const join = unnestFrom(srcRel, e, (e.needsOrd || e.usesRi) ? name("rn") : null);
						const colProjs = (e.node.column || []).map(c => B.compileColumn(c, e.childElem));
						cols = cols || colProjs.map(c => c.name);
						const sel = [...keyCols, ...carried, ...colProjs.map(c => c.sql)];
						parts.push(`SELECT ${sel.join(", ")} FROM ${join}`);
					}
				} else {
					// columns-only branch: select the stage-materialised column values
					cols = cols || e.cols.map(c => c.name);
					const sel = [...keyCols, ...carried, ...e.cols.map(c => `${c.matcol} AS ${c.name}`)];
					parts.push(`SELECT ${sel.join(", ")} FROM ${srcRel}`);
				}
			});
		};
		collect(prepared, relName);
		const uName = name("u");
		ctes.push(`${uName} AS (\n  ${parts.join("\n  UNION ALL\n  ")}\n)`);
		return {rel: uName, cols: [...carried, ...cols]};
	}

	const rootElem = {ref: null, inLambda: false, seed: vd.resource, inputType: {}, rowIndexSql: "0"};
	const result = emitScope(vd, rootElem, [], rootKey, null, true, []);

	const order = columnOrder(vd);
	const outputColumns = order.join(", ");
	// The sealed pipeline (SPEC_sql_template_contract §3): the typed `_fq_src` projection reading from the
	// template-provided `_fq_input`, the flattening CTEs, then a column-clean `_fq_output`. `_fq_src` carries
	// the `MATERIALIZED` hint when a volatile root key requires it. No leading/trailing comma and no
	// terminal SELECT — the template owns the comma joining its input CTE and the final projection.
	const srcCte = `${SRC_CTE} AS ${srcMaterialized ? "MATERIALIZED " : ""}(\n  SELECT ${emitScope.srcSelect}\n  FROM ${INPUT_CTE}\n)`;
	const outputCte = `${OUTPUT_CTE} AS (\n  SELECT ${outputColumns}\n  FROM ${result.rel}\n)`;
	const pipeline = [srcCte, ...ctes, outputCte].join(",\n");

	// A `where` path evaluates at the resource root and may navigate a repeat-forced field, so it
	// needs the same inline re-type a root column gets (issue #35) — otherwise it reads raw JSON and
	// errors on comparison. `forcedJsonPaths` is fully accumulated now (the root walk is done); build
	// a root re-type map (resource-rooted path -> from_json cast macro, pooled via castMacroFor) from
	// the fields the where paths actually navigate, and return it for the caller to thread in.
	let whereRetype = null;
	const wherePaths = (vd.where || []).map(w => w.path);
	if (wherePaths.length && forcedJsonPaths.length) {
		const structs = forcedFieldStructures(
			wherePaths.map(p => ({name: "_w", path: p})), vd.resource, [...new Set(forcedJsonPaths)], schema, vars);
		if (structs.size) whereRetype = buildRetypeMap(structs, rootElem);
	}

	return {
		withKeyword: viewHasRepeat ? "WITH RECURSIVE" : "WITH",
		inputName: INPUT_CTE,
		pipeline,
		outputName: OUTPUT_CTE,
		outputColumns,
		viewMacros: macroDefs.length ? macroDefs.join("\n") + "\n" : "",
		resourceKeyAst,
		forcedJsonPaths,
		whereRetype
	};
}
