import {fhirpathToAst} from "./fhirpath-parser.js";
import {astToSql} from "./ddb-sql-builder.js";
import {assertSimplePath, jsonFold, typedSeed, repeatStructure, childElemOf} from "./repeat-lowering.js";

// Staged-CTE emitter (SPEC_hybrid). Walks the ViewDefinition tree, classifies each
// scope CHAIN (<=1 fan-out) or FORK (>=2), and emits staged CTEs. Leaves are compiled
// by the existing typed FHIRPath engine; the scope element is aliased `node` and passed
// as the engine's outer root-var so internal `el` lambdas never collide (design D2).
//
// `repeat` is the one unbounded-depth directive, so it cannot live on the typed substrate:
// the descent is performed in JSON (a `WITH RECURSIVE` CTE over a JSON node, design D1),
// while every column/forEach/where is still evaluated typed — the recursion's JSON node is
// converted per-scope to a typed element with a lenient `from_json` (design D4/D5), and the
// existing leaf engine compiles against it unchanged. The binding mode oscillates: typed
// scopes read `read_json` columns / `node`; a `repeat` scope reads `el = from_json(node)`.

// --- tree helpers ---------------------------------------------------------

// Does the ViewDefinition contain any `repeat`? (forces a leading `WITH RECURSIVE`, design D7).
function hasRepeat(node) {
	if (!node || typeof node !== "object") return false;
	if (node.repeat) return true;
	return (node.select || []).some(hasRepeat) || (node.unionAll || []).some(hasRepeat);
}

// Collect a scope's direct columns and fan-out children. A nested `select` with no
// fan-out directive is transparent: its columns and fan-outs merge into this scope.
// A `repeat` child is a fan-out classified as `{type: "repeat"}` (design D6).
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
function subtreeHasFork(node) {
	const {fanouts} = collectScope(node);
	if (fanouts.length >= 2) return true;
	return fanouts.some(f => (f.type === "each" || f.type === "repeat") && subtreeHasFork(f.node));
}

// Raw-string `%rowIndex` detection, used ONLY for the structural look-ahead that forces a partition
// key down a spine to a `%rowIndex` repeat (design D3). Over-approximation is safe here: a false
// positive can only force an extra, harmless carried key, never alter a `%rowIndex`-free view (which
// contains no `%rowIndex` token to match). The precise per-scope binding decision still parses the
// resolved AST (`scopeUsesRowIndex`), so this raw scan never affects which value is emitted.
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
// branches) reference `%rowIndex`? Mirrors the candidate set of `scopeUsesRowIndex`.
function repeatScopeUsesRowIndex(repeatNode) {
	const {columns, fanouts} = collectScope(repeatNode);
	if (columns.some(c => pathMentionsRowIndex(c.path || c.name))) return true;
	return fanouts.filter(f => f.type === "union")
		.some(f => unionBranchesMentionRowIndex(f.node.unionAll));
}
// Does any `repeat` anywhere in `node`'s subtree have a body that references `%rowIndex`? Forces the
// resource key (`rid`) and the enclosing iterating steps' ordinals to be minted on the spine down to
// that repeat, so its pre-order window can partition by the enclosing-scope instance (design D3).
function subtreeHasRepeatUsingRowIndex(node) {
	if (!node || typeof node !== "object") return false;
	if (node.repeat && repeatScopeUsesRowIndex(node)) return true;
	return (node.select || []).some(subtreeHasRepeatUsingRowIndex)
		|| (node.unionAll || []).some(subtreeHasRepeatUsingRowIndex);
}

// VD column names in document (tree) order — the output projection contract.
function columnOrder(node) {
	let names = [];
	(node.column || []).forEach(c => names.push(c.name));
	(node.select || []).forEach(ch => names.push(...columnOrder(ch)));
	if (node.unionAll) names.push(...columnOrder(node.unionAll[0]));
	return names.filter((n, i) => names.indexOf(n) === i);
}

// Deep-walk a FHIRPath AST (nested arrays of segments, each with possible `args`/`type`
// sub-trees) for the contextual `%rowIndex` segment emitted by the front end. Used to decide,
// before a column is compiled, whether its enclosing iteration must expose a `WITH ORDINALITY`
// ordinal (design D5). The AST is a finite tree, so the recursion terminates.
function astHasRowIndex(node) {
	if (Array.isArray(node)) return node.some(astHasRowIndex);
	if (node && typeof node === "object") {
		if (node.segmentType === "rowIndex") return true;
		return Object.values(node).some(astHasRowIndex);
	}
	return false;
}

// --- leaf compilation (reuses the typed engine) ---------------------------

export function makeBuilder(schema, vars) {

	function compilePath(pathStr, elem) {
		const ast = fhirpathToAst(pathStr, elem.seed, schema, vars);
		const out = astToSql(ast, elem.inLambda, elem.inputType, elem.ref || "el", elem.rowIndexSql || "0");
		return {sql: out.sql, outputType: out.outputType, type: ast.type};
	}

	function compileColumn(col, elem) {
		const pathExpr = col.path || col.name;
		const fpStr = `_col${col.collection ? "_collection" : ""}('${col.name}', ${pathExpr})`;
		const ast = fhirpathToAst(fpStr, elem.seed, schema, vars);
		const out = astToSql(ast, elem.inLambda, elem.inputType, elem.ref || "el", elem.rowIndexSql || "0");
		const expr = out.sql.replace(new RegExp(`^'${col.name}':\\s*`), "");
		return {name: col.name, expr, sql: `${expr} AS ${col.name}`};
	}

	// Wrap a non-list path as a 1-element list so it can be UNNESTed. Use the SQL-level
	// array-ness (outputType), not the FHIR cardinality of the final step: navigation
	// through an array flattens to a list (e.g. `contact.name`), and an indexer like
	// `telecom[0]` yields a scalar even though `telecom` is a list.
	function arrayize(pathStr, elem) {
		const {sql, outputType} = compilePath(pathStr, elem);
		return outputType.isArray ? sql : `as_list(${sql})`;
	}

	const builder = {compilePath, compileColumn, arrayize};
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

	// `%rowIndex` for an iteration's body: the 0-based position from the 1-based `WITH ORDINALITY`
	// ordinal. A `forEachOrNull` over an empty collection yields a null row whose ordinal is NULL,
	// which must report 0 — hence the coalesce (design D3, the staged analog of struct source-padding).
	// DuckDB's ORDINALITY is BIGINT, but `%rowIndex` is an INTEGER, so cast (matching the struct emitter).
	const rowIndexExpr = (ord, orNull) =>
		(orNull ? `(coalesce(${ord}, 1) - 1)` : `(${ord} - 1)`) + "::INTEGER";

	// Does `pathExpr`, evaluated against `elem`, reference `%rowIndex`? Parse it (cheap at build
	// time) and look for the contextual segment rather than pattern-matching the raw string (D5).
	const pathUsesRowIndex = (pathExpr, elem) =>
		astHasRowIndex(fhirpathToAst(pathExpr, elem.seed, schema, vars));

	// Does any column compiled against THIS scope's element reference `%rowIndex` — i.e. does the
	// enclosing iteration need to expose an ordinal? Candidates are the scope's own (direct +
	// transparently merged) columns and any columns-only `unionAll` branch (which materialises into
	// this stage). A nested `forEach`/`repeat`, or a `forEach`/`repeat` union branch, opens its own
	// ordinal and is detected when ITS parent makes the same decision, so they are excluded (D5).
	function scopeUsesRowIndex(node, elem) {
		const {columns, fanouts} = collectScope(node);
		if (columns.some(c => pathUsesRowIndex(c.path || c.name, elem))) return true;
		return fanouts.filter(f => f.type === "union")
			.some(f => unionColsOnlyUseRowIndex(f.node.unionAll, elem));
	}
	function unionColsOnlyUseRowIndex(branches, elem) {
		return branches.some(b => {
			if (b.unionAll) return unionColsOnlyUseRowIndex(b.unionAll, elem);
			if (b.forEach || b.forEachOrNull || b.repeat) return false; // opens its own ordinal
			return (b.column || []).some(c => pathUsesRowIndex(c.path || c.name, elem));
		});
	}

	const viewHasRepeat = hasRepeat(vd);
	const viewHasFork = subtreeHasFork(vd);
	// A `%rowIndex` repeat needs a per-resource (or per-enclosing-instance) partition key even when
	// the view has no fork, so force the root `rid` whenever any repeat below uses `%rowIndex` (D3).
	const viewHasRepeatRowIndex = subtreeHasRepeatUsingRowIndex(vd);
	const forceRootKey = viewHasFork || viewHasRepeatRowIndex;
	const rootKey = forceRootKey ? ["rid"] : [];

	// Cast macros: each distinct `from_json` structure becomes one `fq_cast_*` macro emitted
	// in the preamble; identical structures (e.g. a repeat's single canonical descent type)
	// share a macro (design D8).
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
	// sibling navigation would otherwise type them ("repeat wins", design D3 shared-field).
	const forcedJsonPaths = [];

	// The root `rid` is the recombination key for any root fork. In "natural" mode it is the
	// resource key (`getResourceKey()` -> `id`), the semantically correct and deterministic
	// identity (no blocking window). In "uuid" mode it is a synthesised per-resource `uuid()`
	// that requires no id-uniqueness assumption, but whose volatility means `src` must be
	// materialised so both fork branches observe the same value.
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
	// once per resource (so fork branches and a repeat's recursive descent all observe the same key).
	const srcMaterialized = forceRootKey && rootKeyMode === "uuid";

	// Prepare a repeat fan-out: validate its paths, resolve the descent element type, and
	// materialise the seed array into the owning stage's projection.
	function prepRepeat(f, elem, schemaPrefix, stageSelect) {
		f.listedPaths = f.node.repeat;
		f.listedPaths.forEach(assertSimplePath);
		f.childElem = B.childElemOf(f.listedPaths[0], elem);
		f.seedCol = name("a") + "_seed";
		stageSelect.push(`${typedSeed(f.listedPaths, elem, B)} AS ${f.seedCol}`);
		// Does the repeat body reference `%rowIndex`? Parse against the typed bridge element it will be
		// evaluated under (D4) — drives the pre-order path + window in `emitRepeat`.
		f.usesRowIndex = scopeUsesRowIndex(f.node, bridgeElem(f.childElem.seed));
		// A seed field read in a typed scope must be JSON[] even if a sibling forEach types it.
		if (schemaPrefix) f.listedPaths.forEach(p =>
			forcedJsonPaths.push([...schemaPrefix, ...p.split(".")].join(".")));
	}

	// Emit a repeat's JSON descent + typed bridge, then continue the body scope on the typed
	// element `el`. `parentRel` exposes the materialised seed column + the carried/key columns.
	function emitRepeat(f, parentRel, carried, keyCols) {
		const carryCols = [...keyCols, ...carried];
		const carryProj = (rel) => carryCols.map(c => `${rel}.${c}`);
		const lead = (cols) => cols.length ? cols.join(", ") + ", " : "";

		// `%rowIndex` over a repeat (D1-D3): carry an integer descent `path` (the per-level ordinals
		// from the seed to a node) through both legs when this repeat's body uses `%rowIndex`, OR a
		// repeat nested in its body does — the latter needs THIS repeat's own index as its partition
		// surrogate. Ordering the `BIGINT[]` path element-wise gives depth-first pre-order
		// (`[1] < [1,1] < [1,2] < [2]`); the index is assigned by a window at the bridge (one row per
		// visited node, before any fork recombination) and materialised as a scalar that survives joins.
		const innerNeedsOuterRn = (f.node.select || []).some(subtreeHasRepeatUsingRowIndex)
			|| (f.node.unionAll || []).some(subtreeHasRepeatUsingRowIndex);
		const needRepRn = f.usesRowIndex || innerNeedsOuterRn;

		const repName = name("rep");
		const seedPath = needRepRn ? `[ord]::BIGINT[] AS path, ` : "";
		const recPath = needRepRn ? `list_append(${repName}.path, ord), ` : "";
		const seedOrd = needRepRn ? ` WITH ORDINALITY AS _s(node, ord)` : ` AS _s(node)`;
		const recOrd = needRepRn ? ` WITH ORDINALITY AS _r(node, ord)` : ` AS _r(node)`;
		const seedLeg = `SELECT ${lead(carryProj(parentRel))}${seedPath}_s.node AS node\n    FROM ${parentRel}, UNNEST(${parentRel}.${f.seedCol})${seedOrd}`;
		const recLeg = `SELECT ${lead(carryProj(repName))}${recPath}_r.node\n    FROM ${repName}, UNNEST(${jsonFold(f.listedPaths, `${repName}.node`)})${recOrd}`;
		ctes.push(`${repName} AS (\n    ${seedLeg}\n    UNION ALL\n    ${recLeg}\n  )`);

		const structure = B.repeatStructure(f.node, f.childElem.seed);
		const cast = `${castMacroFor(structure, f.childElem.seed)}(node)`;
		const bridge = name("repb");
		const bodyElem = bridgeElem(f.childElem.seed);
		let bodyKeyCols = keyCols;
		if (needRepRn) {
			const rnCol = name("rrn");
			const part = keyCols.length ? `PARTITION BY ${keyCols.join(", ")} ` : "";
			const rn = `(row_number() OVER (${part}ORDER BY path) - 1)::INTEGER AS ${rnCol}`;
			ctes.push(`${bridge} AS (\n  SELECT ${lead(carryCols)}${rn}, ${cast} AS el\n  FROM ${repName}\n)`);
			if (f.usesRowIndex) bodyElem.rowIndexSql = rnCol;            // this repeat's own %rowIndex
			if (innerNeedsOuterRn) bodyKeyCols = [...keyCols, rnCol];    // surrogate for a nested repeat
		} else {
			ctes.push(`${bridge} AS (\n  SELECT ${lead(carryCols)}${cast} AS el\n  FROM ${repName}\n)`);
		}

		// The body of a repeat is evaluated in `json` mode (its element is the from_json `el`);
		// nested repeat seeds arrive as `el.<field>` JSON[] and re-enter `WITH RECURSIVE`.
		return emitScope(f.node, bodyElem, carried, bodyKeyCols, bridge, false, null);
	}

	// The typed element produced by a from_json bridge over a JSON node column.
	function bridgeElem(seed) {
		return {ref: "el", inLambda: true, seed, inputType: {fhirType: "BackboneElement", isArray: false, schemaPath: seed}};
	}

	// A `forEach` over a field that a sibling `repeat` forces to JSON[] (the shared-field case,
	// design D3/Risks): unnest the JSON list and consume each node through the same from_json
	// typed bridge a repeat scope uses — no recursion, just one descent level.
	function emitJsonEach(f, parentRel, carried, keyCols, ordName) {
		const childKey = ordName ? [...keyCols, ordName] : keyCols;
		const carryCols = [...childKey, ...carried];
		const from = unnestFrom(parentRel, f, ordName);
		const structure = B.repeatStructure(f.node, f.childElem.seed);
		const cast = `${castMacroFor(structure, f.childElem.seed)}(node)`;
		const bridge = name("repb");
		ctes.push(`${bridge} AS (\n  SELECT ${carryCols.length ? carryCols.join(", ") + ", " : ""}${cast} AS el\n  FROM ${from}\n)`);
		// `%rowIndex` of this shared-field iteration: the ordinal (carried via childKey) less one. Same
		// binding as a typed `forEach`, but on the from_json bridge element.
		const bodyElem = bridgeElem(f.childElem.seed);
		if (ordName && f.usesRowIndex) bodyElem.rowIndexSql = rowIndexExpr(ordName, f.orNull);
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
		// from_json bridge rather than as a typed struct array (shared-field case, design D3).
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
			f.arrCol = name("a") + "_arr";
			f.orNull = !!f.node.forEachOrNull;
			f.childElem = B.childElemOf(path, elem);
			// The ordinal becomes a carried KEY when a fork below needs it for recombination OR a
			// `%rowIndex` repeat below needs it as a partition surrogate (design D2/D3); it is needed
			// merely as a VALUE (aliased, not keyed) when this scope itself reads `%rowIndex`.
			f.forkOrd = subtreeHasFork(f.node) || subtreeHasRepeatUsingRowIndex(f.node);
			f.usesRowIndex = scopeUsesRowIndex(f.node, f.childElem);
			f.needsOrd = f.forkOrd || f.usesRowIndex;
			f.segs = path.split(".");
			stageSelect.push(`${B.arrayize(path, elem)} AS ${f.arrCol}`);
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
				const ordName = f.needsOrd ? `ord${keyCols.length}` : null;
				// Only a fork carries the ordinal forward as a recombination key; the index-only case
				// reads it in the immediate child stage and materialises `%rowIndex` as a data column.
				const childKey = f.forkOrd && ordName ? [...keyCols, ordName] : keyCols;
				if (ordName) f.childElem.rowIndexSql = rowIndexExpr(ordName, f.orNull);
				if (f.jsonMode) return emitJsonEach(f, relName, carriedAfter, keyCols, ordName);
				const from = unnestFrom(relName, f, ordName);
				const childPrefix = schemaPrefix ? [...schemaPrefix, ...f.segs] : null;
				return emitScope(f.node, f.childElem, carriedAfter, childKey, from, false, childPrefix);
			}
			if (repeatFanouts.length === 1) {
				return emitRepeat(repeatFanouts[0], relName, carriedAfter, keyCols);
			}
			// sole unionAll
			return emitUnion(unionFanouts[0].prepared, relName, carriedAfter, keyCols);
		}

		// FORK
		const branches = [];
		realFanouts.forEach(f => {
			// Fork siblings recombine on `keyCols` (the cross product), so the iteration itself needs
			// no ordinal key here; expose one as a VALUE when the branch reads `%rowIndex`, and as a
			// carried branch KEY when a `%rowIndex` repeat below it needs the ordinal as a partition
			// surrogate (D3). Without a repeat below, this stays byte-for-byte the prior fork behavior.
			const repBelow = subtreeHasRepeatUsingRowIndex(f.node);
			const ordName = (f.usesRowIndex || repBelow) ? `ord${keyCols.length}` : null;
			if (ordName && f.usesRowIndex) f.childElem.rowIndexSql = rowIndexExpr(ordName, f.orNull);
			const branchKey = (repBelow && ordName) ? [...keyCols, ordName] : keyCols;
			const br = f.jsonMode
				? emitJsonEach(f, relName, [], keyCols, ordName)
				: emitScope(f.node, f.childElem, [], branchKey, unnestFrom(relName, f, ordName), false, null);
			branches.push({rel: br.rel, cols: br.cols, kind: f.orNull ? "LEFT" : "INNER"});
		});
		repeatFanouts.forEach(f => {
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

	// build a FROM clause that unnests a materialised array column of `relName`
	function unnestFrom(relName, f, ordName) {
		const a = `_u${++counter}`;
		if (ordName) {
			return f.orNull
				? `${relName}\n  LEFT JOIN UNNEST(${relName}.${f.arrCol}) WITH ORDINALITY AS ${a}(node, ${ordName}) ON TRUE`
				: `${relName}, UNNEST(${relName}.${f.arrCol}) WITH ORDINALITY AS ${a}(node, ${ordName})`;
		}
		return f.orNull
			? `${relName}\n  LEFT JOIN UNNEST(${relName}.${f.arrCol}) AS ${a}(node) ON TRUE`
			: `${relName}, UNNEST(${relName}.${f.arrCol}) AS ${a}(node)`;
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
				const arrCol = name("u") + "_arr";
				stageSelect.push(`${B.arrayize(path, elem)} AS ${arrCol}`);
				const childElem = B.childElemOf(path, elem);
				return {node: b, arrCol, orNull: !!b.forEachOrNull, childElem,
					usesRowIndex: scopeUsesRowIndex(b, childElem)};
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
					// Each forEach branch has its own ordinal, so `%rowIndex` numbers independently from 0.
					const a = `_b${++counter}`;
					const ordName = e.usesRowIndex ? `uord${counter}` : null;
					if (ordName) e.childElem.rowIndexSql = rowIndexExpr(ordName, e.orNull);
					const unnest = ordName
						? `UNNEST(${srcRel}.${e.arrCol}) WITH ORDINALITY AS ${a}(node, ${ordName})`
						: `UNNEST(${srcRel}.${e.arrCol}) AS ${a}(node)`;
					const join = e.orNull ? `${srcRel}\n  LEFT JOIN ${unnest} ON TRUE` : `${srcRel}, ${unnest}`;
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
		hasRepeat: viewHasRepeat,
		withKeyword: viewHasRepeat ? "WITH RECURSIVE" : "WITH",
		macros: macroDefs.length ? macroDefs.join("\n") + "\n" : "",
		forcedJsonPaths
	};
}
