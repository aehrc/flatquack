import {fhirpathToAst} from "./fhirpath-parser.js";
import {astToSql} from "./ddb-sql-builder.js";

// Staged-CTE emitter (SPEC_hybrid). Walks the ViewDefinition tree, classifies each
// scope CHAIN (<=1 fan-out) or FORK (>=2), and emits staged CTEs. Leaves are compiled
// by the existing typed FHIRPath engine; the scope element is aliased `node` and passed
// as the engine's outer root-var so internal `el` lambdas never collide (design D2).

// --- tree helpers ---------------------------------------------------------

function assertNoRepeat(node) {
	if (!node || typeof node !== "object") return;
	if (node.repeat) throw new Error("`repeat` is not supported by the staged backend");
	(node.select || []).forEach(assertNoRepeat);
	(node.unionAll || []).forEach(assertNoRepeat);
}

// Collect a scope's direct columns and fan-out children. A nested `select` with no
// fan-out directive is transparent: its columns and fan-outs merge into this scope.
function collectScope(node) {
	let columns = node.column ? [...node.column] : [];
	let fanouts = [];
	(node.select || []).forEach(child => {
		if (child.forEach || child.forEachOrNull) {
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
		|| fanouts.some(f => f.type === "each" && subtreeHasFork(f.node));
	forkCache.set(node, result);
	return result;
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

	// Prepare a fan-out over `pathStr` from `elem` in a single compile pass, returning both the
	// array SQL to UNNEST and the child scope element. (childElemOf and arrayize used to compile
	// the same path twice.)
	//   - arrSql: wrap a non-list path as a 1-element list so it can be UNNESTed. Use the SQL-level
	//     array-ness (outputType), not the FHIR cardinality of the final step: navigation through an
	//     array flattens to a list (e.g. `contact.name`), and an indexer like `telecom[0]` yields a
	//     scalar even though `telecom` is a list.
	//   - childElem: the element produced by iterating `pathStr`.
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

	return {compilePath, compileColumn, prepareFanout};
}

// --- main entry -----------------------------------------------------------

export function buildStagedQuery(vd, schema, vars, opts = {}) {
	assertNoRepeat(vd);
	const B = makeBuilder(schema, vars);

	const rootKeyMode = opts.rootKey || "natural";
	if (rootKeyMode !== "natural" && rootKeyMode !== "uuid")
		throw new Error(`unknown rootKey mode: ${rootKeyMode} (expected "natural" or "uuid")`);

	const ctes = [];
	let counter = 0;
	const name = (base) => `${base}_${++counter}`;

	const viewHasFork = subtreeHasFork(vd);
	const rootKey = viewHasFork ? ["rid"] : [];

	// The root `rid` is the recombination key for any root fork. In "natural" mode it is the
	// resource key, sourced from `getResourceKey()` so that a future change to that function's
	// definition propagates to the key automatically. NOTE: `getResourceKey()` currently
	// resolves to the bare `id` (no `ResourceType/` prefix), so the natural key only
	// disambiguates within a single resource type; mixed-type reads risk a cross-type id
	// collision at a root fork (see issue #26). In "uuid" mode it is a synthesised per-resource
	// `uuid()` that requires no id-uniqueness assumption, but whose volatility means `src` must
	// be materialised so both fork branches observe the same value.
	const rootKeyExpr = rootKeyMode === "uuid"
		? "uuid()"
		: B.compilePath("getResourceKey()", {ref: null, inLambda: false, seed: vd.resource, inputType: {}}).sql;
	// Natural-key mode reads the resource key, which the ViewDefinition need not otherwise
	// reference; expose its AST so the caller can add it to the typed read schema. Lazy: only
	// when a fork actually needs the key (chain-only views and "uuid" mode add nothing).
	const resourceKeyAst = (viewHasFork && rootKeyMode === "natural")
		? fhirpathToAst("getResourceKey()", vd.resource, schema, vars)
		: null;
	// "uuid()" is volatile: the source scope must be materialised so it is evaluated exactly
	// once per resource and both branches join on the same key.
	const srcMaterialized = viewHasFork && rootKeyMode === "uuid";

	// emitScope: builds a stage exposing keyCols + carried + this scope's columns, then
	// chains or forks. `fromSql` is the FROM clause for this stage (null at root: the
	// stage is `src`, whose FROM lives in the template). Returns {rel, cols}.
	function emitScope(scopeNode, elem, carried, keyCols, fromSql, isRoot) {
		const {columns, fanouts} = collectScope(scopeNode);
		const colProjs = columns.map(c => B.compileColumn(c, elem));
		const carriedAfter = [...carried, ...colProjs.map(c => c.name)];

		const realFanouts = fanouts.filter(f => f.type === "each");
		const unionFanouts = fanouts.filter(f => f.type === "union");
		const total = realFanouts.length + unionFanouts.length;

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
			f.needsOrd = subtreeHasFork(f.node);
			stageSelect.push(`${arrSql} AS ${f.arrCol}`);
		});
		// materialise arrays needed by unionAll branches
		unionFanouts.forEach(f => {
			f.prepared = prepUnion(f.node.unionAll, elem, stageSelect);
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
				// iteration's `%rowIndex` source; otherwise a private `rn{n}` ordinal supplies it.
				const ordName = f.needsOrd ? `ord${keyCols.length}` : `rn${++counter}`;
				const childKey = f.needsOrd ? [...keyCols, ordName] : keyCols;
				const from = unnestFrom(relName, f, ordName);
				bindRowIndex(f, ordName);
				return emitScope(f.node, f.childElem, carriedAfter, childKey, from, false);
			}
			// sole unionAll
			return emitUnion(unionFanouts[0].prepared, relName, carriedAfter, keyCols);
		}

		// FORK
		const branches = [];
		realFanouts.forEach(f => {
			const ordName = `rn${++counter}`;
			const from = unnestFrom(relName, f, ordName);
			bindRowIndex(f, ordName);
			const br = emitScope(f.node, f.childElem, [], keyCols, from, false);
			branches.push({rel: br.rel, cols: br.cols, kind: f.orNull ? "LEFT" : "INNER"});
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

	// build a FROM clause that unnests a materialised array column of `relName`
	function unnestFrom(relName, f, ordName) {
		return unnestClause(relName, f.arrCol, `_u${++counter}`, f.orNull, ordName);
	}

	// --- unionAll ----------------------------------------------------------
	// prepUnion materialises each branch's forEach array into the owning stage and
	// returns a tree describing how to emit the branch pipelines.
	function prepUnion(unionBranches, elem, stageSelect) {
		return unionBranches.map(b => {
			if (b.unionAll) return {nested: prepUnion(b.unionAll, elem, stageSelect)};
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
				if (e.arrCol) {
					// Each iterating unionAll branch gets its own `%rowIndex` ordinal (resets per
					// branch), exactly like a forEach/forEachOrNull elsewhere.
					const ordName = `rn${++counter}`;
					const join = unnestClause(srcRel, e.arrCol, `_b${++counter}`, e.orNull, ordName);
					bindRowIndex(e, ordName);
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

	const rootElem = {ref: null, inLambda: false, seed: vd.resource, inputType: {}};
	const result = emitScope(vd, rootElem, [], rootKey, null, true);

	const order = columnOrder(vd);
	const finalSelect = `SELECT ${order.join(", ")}\nFROM ${result.rel}`;
	const tail = (ctes.length ? ",\n" + ctes.join(",\n") : "") + "\n" + finalSelect;

	return {srcSelect: emitScope.srcSelect, tail, srcMaterialized, resourceKeyAst};
}
