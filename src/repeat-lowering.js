import {fhirpathToAst} from "./fhirpath-parser.js";
import {pathsToJsonStruct} from "./ddb-sql-builder.js";
import {parseVd, extractPathsFromAst} from "./view-parser.js";

// Backend-agnostic `repeat` lowering helpers, shared by the staged (`WITH RECURSIVE`) and the
// struct (`list_reduce` accumulator) emitters. The two emitters differ only in how they host the
// recursion; the JSON-typed mix below (forced-JSON seed, `fhir_list` descent, `from_json` typed
// bridge, typed leaf evaluation) is identical, so it lives here once (design D6).

// A listed `repeat` path must be a simple dot-separated traversal of element names; anything
// using a function/filter/indexer (where()/ofType()/first()/[n]) is rejected (design Non-goal).
export function assertSimplePath(p) {
	if (typeof p !== "string" || !/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(p))
		throw new Error(`repeat supports simple traversal paths only; got '${p}'`);
}

// The JSON descent fold for the recursive leg: re-apply each listed path to a visited JSON
// node (single step `fhir_list(node -> '$.p')`; multi-step `a.b` flattens through `a`;
// multiple paths concatenate), design D1.
export function jsonFold(paths, nodeExpr) {
	const folds = paths.map(p => {
		const steps = p.split(".");
		let expr = `fhir_list(${nodeExpr} -> '$.${steps[0]}')`;
		for (let i = 1; i < steps.length; i++)
			expr = `list_transform(${expr}, x -> fhir_list(x -> '$.${steps[i]}')).flatten()`;
		return expr;
	});
	return folds.length === 1 ? folds[0] : `list_concat(${folds.join(", ")})`;
}

// The seed array off the enclosing element for a repeat's listed paths: each path is the
// typed navigation of that path (a repeat seed reads as JSON[]); paths that do not resolve
// off this element (e.g. `answer.item` off the resource focus) contribute nothing. `B` is the
// builder handle exposing `compilePath`/`arrayize`.
export function typedSeed(paths, elem, B) {
	const parts = [];
	paths.forEach(p => {
		let resolved;
		try { resolved = B.compilePath(p, elem); } catch { return; }
		if (resolved.type && resolved.type.fhirType) parts.push(B.arrayize(p, elem));
	});
	if (!parts.length) return "[]::JSON[]";
	return parts.length === 1 ? parts[0] : `list_concat(${parts.join(", ")})`;
}

// The element produced by iterating `pathStr` from `elem`. `B` exposes `compilePath`.
export function childElemOf(pathStr, elem, B) {
	const {type} = B.compilePath(pathStr, elem);
	return {
		ref: "node",
		inLambda: true,
		seed: type.schemaPath,
		inputType: {fhirType: type.fhirType, isArray: false, schemaPath: type.schemaPath}
	};
}

// The `from_json` structure for a repeat scope: pathsToJsonStruct over the scope's
// column/forEach/where paths, rooted at the scope element, truncated at nested repeat seeds
// (design D5). Reuses parseVd's path walk (which surfaces a nested repeat's seed childless ->
// raw JSON[]) rooted at the element's schemaPath.
export function repeatStructure(repeatNode, elemSchemaPath, schema, vars) {
	// Wrap the body (sans `repeat`) as a nested select so a column-only body is walked as a
	// scope (parseVd only emits a root projection wrapper for `select`, not bare `column`).
	const body = {column: repeatNode.column, select: repeatNode.select, unionAll: repeatNode.unionAll};
	const pseudoVd = {resource: elemSchemaPath, select: [body]};
	const {path} = parseVd(pseudoVd, true);
	if (!path) return "{}";
	const ast = fhirpathToAst(path, elemSchemaPath, schema, vars);
	return pathsToJsonStruct(extractPathsFromAst({asts: [ast]}));
}

// The bounded `list_reduce` accumulator for the struct emitter (design D1/D2/D5). Produces the
// truncated typed repeat elements (seed + descendants down to `depth` levels); the caller projects
// the body once over the result, and the existing flattener `CROSS JOIN UNNEST`s it like a
// forEach. Field names are `acc`/`cur` (never `all` — reserved word); the bridge lambda var `rb`
// is distinct from the body lambda var so the two transforms never shadow.
//
// Two cost-shaping choices: (1) the JSON frontier lives only in `cur` and advances once per step;
// `acc` collects the *previous* frontier, so the descent (`expand`) is computed once per step, not
// twice — the one-step lag is absorbed by seeding `acc` empty and running one extra fold
// (`depth+2`). (2) each frontier is converted to the **truncated** typed element by `from_json`
// *as it enters* `acc`, so the repeatedly `list_concat`-copied `acc` holds the typed projection
// (nested-repeat seeds stay `JSON[]`), not the fat raw JSON node with its whole descendant
// subtree. The empty `acc` seed is minted by `from_json` over an empty list so its element type is
// inferred (no STRUCT type rendered). Only this compact bridge is duplicated in init/step; the
// (potentially large, nested) body projection is applied once, by the caller, after the reduce.
export function reduceSource(seed, paths, structure, depth) {
	const typed = frontier => `list_transform(${frontier}, rb -> from_json(rb, '${structure}'))`;
	const expand = `flatten(list_transform(st.cur, n -> ${jsonFold(paths, "n")}))`;
	const init = `{acc: ${typed("[]::JSON[]")}, cur: ${seed}}`;
	const step = `(st, x) -> CASE WHEN len(st.cur) > 0`
		+ ` THEN {acc: list_concat(st.acc, ${typed("st.cur")}), cur: ${expand}}`
		+ ` ELSE st END`;
	return `(list_reduce(list_resize([${init}], ${depth}+2), ${step})).acc`;
}
