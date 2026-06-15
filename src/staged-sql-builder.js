import {fhirpathToAst} from "./fhirpath-parser.js";
import {astToSql} from "./ddb-sql-builder.js";
import {assertSimplePath, jsonFold, typedSeed, repeatStructure, childElemOf} from "./repeat-lowering.js";

// Staged-CTE emitter (SPEC_hybrid). Walks the ViewDefinition tree, classifies each
// scope CHAIN (<=1 fan-out) or FORK (>=2), and emits staged CTEs. Leaves are compiled
// by the existing typed FHIRPath engine; the scope element is aliased `node` and passed
// as the engine's outer root-var so internal `el` lambdas never collide (design D2).
//
// `repeat` is the one unbounded-depth directive, so it cannot live on the typed substrate:
// the descent is performed in JSON (a `WITH RECURSIVE` CTE over a JSON node, SPEC_hybrid §5),
// while every column/forEach/where is still evaluated typed — the recursion's JSON node is
// converted per-scope to a typed element with a lenient `from_json` bridge, and the existing leaf
// engine compiles against it unchanged. The binding mode oscillates: typed scopes read
// `read_json_auto` columns / `node`; a `repeat` scope reads `el = from_json(node)`.

// The column a repeat's from_json bridge binds its typed element to. Deliberately NOT `el`: the
// typed leaf engine names its internal `list_transform`/`list_filter` lambda parameter `el`, so a
// repeat-scope column whose path navigates through an array (e.g. `answer.value.ofType(string)`)
// would otherwise shadow the bridge element with the lambda element and bind the wrong struct. A
// distinct bridge name keeps the two separate; it is both the CTE column alias and the leaf root-var.
const BRIDGE_VAR = "el_r";

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

// Raw-string `%rowIndex` detection, used ONLY for the structural look-ahead that forces a partition
// key down a spine to a `%rowIndex` repeat (Stage 4). Over-approximation is safe here: a false
// positive can only force an extra, harmless carried key, never alter a `%rowIndex`-free view (which
// contains no `%rowIndex` token to match). The precise per-scope binding decision still parses the
// resolved AST when the column is compiled, so this raw scan never affects which value is emitted.
function pathMentionsRowIndex(p) {
	return typeof p === "string" && /%rowIndex\b/.test(p);
}
function unionBranchesMentionRowIndex(branches) {
	return branches.some(b => {
		if (b.unionAll) return unionBranchesMentionRowIndex(b.unionAll);
		if (b.forEach || b.forEachOrNull || b.repeat) return false; // opens its own scope
		return (b.column || []).some(c => pathMentionsRowIndex(c.path || c.name));
	});
}
// Does a `repeat`'s own scope (direct + transparently-merged columns, and columns-only `unionAll`
// branches) reference `%rowIndex`? Mirrors the candidate set the scope actually compiles its
// `%rowIndex`-binding columns against (a nested forEach/repeat/union-iterating branch opens its own
// scope and is excluded).
function repeatScopeUsesRowIndex(repeatNode) {
	const {columns, fanouts} = collectScope(repeatNode);
	if (columns.some(c => pathMentionsRowIndex(c.path || c.name))) return true;
	return fanouts.filter(f => f.type === "union")
		.some(f => unionBranchesMentionRowIndex(f.node.unionAll));
}
// Does any `repeat` anywhere in `node`'s subtree have a body that references `%rowIndex`? A
// `%rowIndex` repeat assigns its index by a window partitioned by its enclosing-scope instance, so
// the resource key (`rid`) and any enclosing iterating step's ordinal must be minted on the spine
// down to that repeat. Forces the root key and carried ordinals even in a fork-free view.
function subtreeHasRepeatUsingRowIndex(node) {
	if (!node || typeof node !== "object") return false;
	if (node.repeat && repeatScopeUsesRowIndex(node)) return true;
	return (node.select || []).some(subtreeHasRepeatUsingRowIndex)
		|| (node.unionAll || []).some(subtreeHasRepeatUsingRowIndex);
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

// VD column names in document (tree) order — the output projection contract.
function columnOrder(node) {
	let names = [];
	(node.column || []).forEach(c => names.push(c.name));
	(node.select || []).forEach(ch => names.push(...columnOrder(ch)));
	if (node.unionAll) names.push(...columnOrder(node.unionAll[0]));
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

	function compileColumn(col, elem) {
		const pathExpr = col.path || col.name;
		const fpStr = `_col${col.collection ? "_collection" : ""}('${col.name}', ${pathExpr})`;
		const ast = fhirpathToAst(fpStr, elem.seed, schema, vars);
		const out = astToSql(ast, elem.inLambda, elem.inputType, elem.ref || "el", elem.rowIndexSql);
		const expr = out.sql.replace(new RegExp(`^'${col.name}':\\s*`), "");
		return {name: col.name, expr, sql: `${expr} AS ${col.name}`};
	}

	// Wrap a non-list path as a 1-element list so it can be UNNESTed. Use the SQL-level
	// array-ness (outputType), not the FHIR cardinality of the final step: navigation through an
	// array flattens to a list (e.g. `contact.name`), and an indexer like `telecom[0]` yields a
	// scalar even though `telecom` is a list.
	function arrayize(pathStr, elem) {
		const {sql, outputType} = compilePath(pathStr, elem);
		return outputType.isArray ? sql : `as_list(${sql})`;
	}

	// Prepare a fan-out over `pathStr` from `elem` in a single compile pass, returning both the
	// array SQL to UNNEST and the child scope element.
	function prepareFanout(pathStr, elem) {
		const {sql, outputType, type} = compilePath(pathStr, elem);
		return {
			arrSql: outputType.isArray ? sql : `as_list(${sql})`,
			childElem: {
				ref: "node",
				inLambda: true,
				seed: type.schemaPath,
				inputType: {fhirType: type.fhirType, isArray: false, schemaPath: type.schemaPath}
			}
		};
	}

	const builder = {compilePath, compileColumn, arrayize, prepareFanout};
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
	const name = (base) => `${base}_${++counter}`;

	const viewHasRepeat = hasRepeat(vd);
	const viewHasFork = subtreeHasFork(vd);
	// A `%rowIndex` repeat partitions its pre-order window by its enclosing-scope instance, so it
	// needs a per-resource partition key even when the view has no fork — force the root `rid`
	// whenever any repeat below uses `%rowIndex` (Stage 4), in addition to the fork case.
	const viewHasRepeatRowIndex = subtreeHasRepeatUsingRowIndex(vd);
	const forceRootKey = viewHasFork || viewHasRepeatRowIndex;
	const rootKey = forceRootKey ? ["rid"] : [];

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

	// Repeat seed fields that must be forced to JSON[] in the typed read schema even when a
	// sibling navigation would otherwise type them ("repeat wins").
	const forcedJsonPaths = [];

	// The root `rid` is the recombination key for any root fork. In "natural" mode it is the
	// resource key, sourced from `getResourceKey()`. In "uuid" mode it is a synthesised per-resource
	// `uuid()` that requires no id-uniqueness assumption, but whose volatility means `src` must be
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

	// Does `pathExpr`, evaluated against `elem`, reference `%rowIndex`? Parse it (cheap at build
	// time) and look for the contextual segment, rather than pattern-matching the raw string.
	const pathUsesRowIndex = (pathExpr, elem) =>
		astHasRowIndex(fhirpathToAst(pathExpr, elem.seed, schema, vars));
	// Does any column bound against THIS scope's element reference `%rowIndex`? Candidates are the
	// scope's own (direct + transparently merged) columns and any columns-only `unionAll` branch
	// (which materialises into this stage). A nested forEach/repeat/iterating-union branch opens its
	// own scope and is excluded — it is handled when ITS parent makes the same decision.
	function scopeUsesRowIndex(node, elem) {
		const {columns, fanouts} = collectScope(node);
		if (columns.some(c => pathUsesRowIndex(c.path || c.name, elem))) return true;
		return fanouts.filter(f => f.type === "union")
			.some(f => unionColsOnlyUseRowIndex(f.node.unionAll, elem));
	}
	function unionColsOnlyUseRowIndex(branches, elem) {
		return branches.some(b => {
			if (b.unionAll) return unionColsOnlyUseRowIndex(b.unionAll, elem);
			if (b.forEach || b.forEachOrNull || b.repeat) return false; // opens its own scope
			return (b.column || []).some(c => pathUsesRowIndex(c.path || c.name, elem));
		});
	}

	// Prepare a repeat fan-out: validate its paths, resolve the descent element type, and
	// materialise the seed array into the owning stage's projection.
	function prepRepeat(f, elem, schemaPrefix, stageSelect) {
		f.listedPaths = f.node.repeat;
		f.listedPaths.forEach(assertSimplePath);
		f.childElem = B.childElemOf(f.listedPaths[0], elem);
		f.seedCol = name("a") + "_seed";
		stageSelect.push(`${typedSeed(f.listedPaths, elem, B)} AS ${f.seedCol}`);
		// Does the repeat body bind `%rowIndex`? Parse against the typed bridge element it will be
		// evaluated under — drives the pre-order path + window in `emitRepeat` (Stage 4).
		f.usesRowIndex = scopeUsesRowIndex(f.node, bridgeElem(f.childElem.seed));
		// A seed field read in a typed scope must be JSON[] even if a sibling forEach types it.
		if (schemaPrefix) f.listedPaths.forEach(p =>
			forcedJsonPaths.push([...schemaPrefix, ...p.split(".")].join(".")));
	}

	// Emit a repeat's JSON descent + typed bridge, then continue the body scope on the typed
	// element `el`. `parentRel` exposes the materialised seed column + the carried/key columns.
	// (The descent CTE MUST live under a leading `WITH RECURSIVE`, set up by the caller — a
	// recursive CTE under a plain `WITH` errors as `Catalog Error: Table 'rep' does not exist`.)
	function emitRepeat(f, parentRel, carried, keyCols) {
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
		const seedPath = needRn ? `[ord]::BIGINT[] AS path, ` : "";
		const recPath = needRn ? `list_append(${repName}.path, ord), ` : "";
		const seedOrd = needRn ? ` WITH ORDINALITY AS _s(node, ord)` : ` AS _s(node)`;
		const recOrd = needRn ? ` WITH ORDINALITY AS _r(node, ord)` : ` AS _r(node)`;
		const seedLeg = `SELECT ${lead(carryProj(parentRel))}${seedPath}_s.node AS node\n    FROM ${parentRel}, UNNEST(${parentRel}.${f.seedCol})${seedOrd}`;
		const recLeg = `SELECT ${lead(carryProj(repName))}${recPath}_r.node\n    FROM ${repName}, UNNEST(${jsonFold(f.listedPaths, `${repName}.node`)})${recOrd}`;
		ctes.push(`${repName} AS (\n    ${seedLeg}\n    UNION ALL\n    ${recLeg}\n  )`);

		// The descent visits a single canonical element type; convert each visited JSON node to a
		// typed element with the pooled `from_json` cast macro, then continue the body scope typed.
		const structure = B.repeatStructure(f.node, f.childElem.seed);
		const cast = `${castMacroFor(structure, f.childElem.seed)}(node)`;
		const bridge = name("repb");
		const bodyElem = bridgeElem(f.childElem.seed);
		let bodyKeyCols = keyCols;
		if (needRn) {
			// `ORDER BY path` is a total, deterministic order within the partition (paths are unique per
			// node), so the index is reproducible across every reference to the bridge — no MATERIALIZED
			// needed. When a fork or a nested `%rowIndex` repeat needs the index as a key, `keyCols`
			// always includes the resource key (both force the root key), so the partition is per-resource.
			const rnCol = `nord${keyCols.length}`;
			const part = keyCols.length ? `PARTITION BY ${keyCols.join(", ")} ` : "";
			const rn = `(row_number() OVER (${part}ORDER BY path) - 1)::INTEGER AS ${rnCol}`;
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
		return emitScope(f.node, bodyElem, carried, bodyKeyCols, bridge, false, null);
	}

	// A `forEach` over a field that a sibling `repeat` forces to JSON[] (the shared-field case):
	// unnest the JSON list and consume each node through the same from_json typed bridge a repeat
	// scope uses — no recursion, just one descent level. `forkOrd`, when set, carries the iteration
	// ordinal forward as a recombination key (a fork below needs it); otherwise a private ordinal
	// supplies this iteration's `%rowIndex` only.
	function emitJsonEach(f, parentRel, carried, keyCols, forkOrd) {
		// Mint an ordinal so `%rowIndex` is available even when no fork below needs it as a key —
		// unnestFrom binds the 0-based `%rowIndex` SQL onto `f.childElem.rowIndexSql` from it.
		const ordName = forkOrd || name("rn");
		const childKey = forkOrd ? [...keyCols, ordName] : keyCols;
		const from = unnestFrom(parentRel, f, ordName);
		const structure = B.repeatStructure(f.node, f.childElem.seed);
		const cast = `${castMacroFor(structure, f.childElem.seed)}(node)`;
		const bridge = name("repb");
		// Project the body element plus the iteration's `%rowIndex` value, so the bridge scope can
		// bind `%rowIndex` to a column (the raw ordinal is out of scope past this CTE when private).
		const rnCol = name("jern");
		const carryCols = [...childKey, ...carried];
		ctes.push(`${bridge} AS (\n  SELECT ${carryCols.length ? carryCols.join(", ") + ", " : ""}${f.childElem.rowIndexSql} AS ${rnCol}, ${cast} AS ${BRIDGE_VAR}\n  FROM ${from}\n)`);
		const bodyElem = bridgeElem(f.childElem.seed);
		bodyElem.rowIndexSql = rnCol;
		return emitScope(f.node, bodyElem, carried, childKey, bridge, false, null);
	}

	// emitScope: builds a stage exposing keyCols + carried + this scope's columns, then
	// chains or forks. `fromSql` is the FROM clause for this stage (null at root: the
	// stage is `src`, whose FROM lives in the template). `schemaPrefix` (typed scopes only)
	// is the resource-rooted field path used to mark forced-JSON repeat seeds. Returns {rel, cols}.
	function emitScope(scopeNode, elem, carried, keyCols, fromSql, isRoot, schemaPrefix) {
		const {columns, fanouts} = collectScope(scopeNode);
		const colProjs = columns.map(c => B.compileColumn(c, elem));
		const carriedAfter = [...carried, ...colProjs.map(c => c.name)];

		const realFanouts = fanouts.filter(f => f.type === "each");
		const repeatFanouts = fanouts.filter(f => f.type === "repeat");
		const unionFanouts = fanouts.filter(f => f.type === "union");
		const total = realFanouts.length + repeatFanouts.length + unionFanouts.length;

		// A `forEach` whose field a sibling `repeat` forces to JSON[] must read it via the
		// from_json bridge rather than as a typed struct array (shared-field case).
		const repeatSeedFields = new Set(repeatFanouts.flatMap(f => f.node.repeat));
		realFanouts.forEach(f => { f.jsonMode = repeatSeedFields.has(f.node.forEach || f.node.forEachOrNull); });

		// the root stage defines the resource key; deeper stages carry it forward
		const keyProj = isRoot
			? keyCols.map(k => k === "rid" ? `${rootKeyExpr} AS rid` : k)
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
			stageSelect.push(`${arrSql} AS ${f.arrCol}`);
		});
		// materialise each repeat's seed array (the JSON descent reads from it)
		repeatFanouts.forEach(f => prepRepeat(f, elem, schemaPrefix, stageSelect));
		// materialise arrays needed by unionAll branches
		unionFanouts.forEach(f => {
			f.prepared = prepUnion(f.node.unionAll, elem, stageSelect, schemaPrefix);
		});

		let relName;
		if (isRoot) {
			relName = "src";
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
				// A fork-key ordinal (`ord{depth}`, carried as a key column) doubles as this
				// iteration's `%rowIndex` source; otherwise a private ordinal supplies it.
				if (f.jsonMode) return emitJsonEach(f, relName, carriedAfter, keyCols, f.needsOrd ? `ord${keyCols.length}` : null);
				const ordName = f.needsOrd ? `ord${keyCols.length}` : name("rn");
				const childKey = f.needsOrd ? [...keyCols, ordName] : keyCols;
				const from = unnestFrom(relName, f, ordName);
				const childPrefix = schemaPrefix ? [...schemaPrefix, ...(f.node.forEach || f.node.forEachOrNull).split(".")] : null;
				return emitScope(f.node, f.childElem, carriedAfter, childKey, from, false, childPrefix);
			}
			if (repeatFanouts.length === 1) {
				// A lone `repeat` is a CHAIN: carry the scope scalars through the rCTE, no key.
				return emitRepeat(repeatFanouts[0], relName, carriedAfter, keyCols);
			}
			// sole unionAll
			return emitUnion(unionFanouts[0].prepared, relName, carriedAfter, keyCols);
		}

		// FORK
		const branches = [];
		realFanouts.forEach(f => {
			if (f.jsonMode) {
				const br = emitJsonEach(f, relName, [], keyCols, null);
				branches.push({rel: br.rel, cols: br.cols, kind: f.orNull ? "LEFT" : "INNER"});
				return;
			}
			const from = unnestFrom(relName, f, name("rn"));
			const br = emitScope(f.node, f.childElem, [], keyCols, from, false, null);
			branches.push({rel: br.rel, cols: br.cols, kind: f.orNull ? "LEFT" : "INNER"});
		});
		repeatFanouts.forEach(f => {
			// A `repeat` beside >=1 other fan-out is a FORK branch: carry the fork key through the
			// rCTE and recombine on it (repeat branches are always independent fan-outs, INNER).
			const br = emitRepeat(f, relName, [], keyCols);
			branches.push({rel: br.rel, cols: br.cols, kind: "INNER"});
		});
		unionFanouts.forEach(f => {
			const br = emitUnion(f.prepared, relName, [], keyCols);
			branches.push({rel: br.rel, cols: br.cols, kind: "INNER"});
		});

		const forkName = name("f");
		const sel = [
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
		const tuple = ordName ? `${alias}(node, ${ordName})` : `${alias}(node)`;
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
	function prepUnion(unionBranches, elem, stageSelect, schemaPrefix) {
		return unionBranches.map(b => {
			if (b.unionAll) return {nested: prepUnion(b.unionAll, elem, stageSelect, schemaPrefix)};
			if (b.repeat) {
				const f = {node: b};
				prepRepeat(f, elem, schemaPrefix, stageSelect);
				return {repeat: f};
			}
			if (b.forEach || b.forEachOrNull) {
				const path = b.forEach || b.forEachOrNull;
				const {arrSql, childElem} = B.prepareFanout(path, elem);
				const arrCol = name("u") + "_arr";
				stageSelect.push(`${arrSql} AS ${arrCol}`);
				return {node: b, arrCol, orNull: !!b.forEachOrNull, childElem};
			}
			// columns only (no iteration): materialise each column expr in the stage
			// (the scope element is available there but not carried downstream)
			const cols = (b.column || []).map(c => {
				const {expr, name: cn} = B.compileColumn(c, elem);
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
		const collect = (entries, srcRel) => {
			entries.forEach(e => {
				if (e.nested) { collect(e.nested, srcRel); return; }
				if (e.repeat) {
					// a repeat branch: descend in JSON, then select its body columns keyed/carried
					const br = emitRepeat(e.repeat, srcRel, carried, keyCols);
					const bodyCols = br.cols.slice(carried.length);
					cols = cols || bodyCols;
					const sel = [...keyCols, ...carried, ...bodyCols];
					parts.push(`SELECT ${sel.join(", ")} FROM ${br.rel}`);
				} else if (e.arrCol) {
					// Each iterating unionAll branch gets its own `%rowIndex` ordinal (resets per
					// branch), exactly like a forEach/forEachOrNull elsewhere.
					const join = unnestFrom(srcRel, e, name("rn"));
					const colProjs = (e.node.column || []).map(c => B.compileColumn(c, e.childElem));
					cols = cols || colProjs.map(c => c.name);
					const sel = [...keyCols, ...carried, ...colProjs.map(c => c.sql)];
					parts.push(`SELECT ${sel.join(", ")} FROM ${join}`);
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
	const finalSelect = `SELECT ${order.join(", ")}\nFROM ${result.rel}`;
	const tail = (ctes.length ? ",\n" + ctes.join(",\n") : "") + "\n" + finalSelect;

	return {
		srcSelect: emitScope.srcSelect,
		tail,
		srcMaterialized,
		resourceKeyAst,
		withKeyword: viewHasRepeat ? "WITH RECURSIVE" : "WITH",
		macros: macroDefs.length ? macroDefs.join("\n") + "\n" : "",
		forcedJsonPaths
	};
}
