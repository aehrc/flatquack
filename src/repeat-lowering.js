import {fhirpathToAst} from "./fhirpath-parser.js";
import {pathsToJsonStruct} from "./ddb-sql-builder.js";
import {extractPathsFromAst, viewPaths, navigatePathTree} from "./view-parser.js";

// Backend-agnostic `repeat` lowering helpers for the staged (`WITH RECURSIVE`) emitter. A
// `repeat` descends ONLY its listed paths, recursively, excluding the seed; the descent runs in
// JSON (a recursive CTE over a JSON node), while every column/forEach/where is still evaluated
// typed — the recursion's JSON node is converted per-scope to a typed element with a lenient
// `from_json` bridge, and the existing leaf engine compiles against it unchanged.

// A listed `repeat` path must be a simple dot-separated traversal of element names; anything
// using a function/filter/indexer (where()/ofType()/first()/[n]) is rejected (a recursive descent
// has no well-defined meaning for a filtered path).
export function assertSimplePath(p) {
	if (typeof p !== "string" || !/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(p))
		throw new Error(`repeat supports simple traversal paths only; got '${p}'`);
}

// The JSON descent fold for the recursive leg: re-apply each listed path to a visited JSON
// node (single step `fhir_list(node -> '$.p')`; multi-step `a.b` flattens through `a`;
// multiple paths concatenate).
//   NOTE: inside `list_transform` the lambda is written `lambda x:` (not `x ->`) so the body's
//   JSON arrow `x -> '$.path'` is unambiguous (else DuckDB raises a Binder Error).
export function jsonFold(paths, nodeExpr) {
	const folds = paths.map(p => {
		const steps = p.split(".");
		let expr = `fhir_list(${nodeExpr} -> '$.${steps[0]}')`;
		for (let i = 1; i < steps.length; i++)
			expr = `list_transform(${expr}, lambda x: fhir_list(x -> '$.${steps[i]}')).flatten()`;
		return expr;
	});
	return folds.length === 1 ? folds[0] : `list_concat(${folds.join(", ")})`;
}

// The seed array off the enclosing element for a repeat's listed paths: each path is the typed
// navigation of that path (a repeat seed reads as JSON[]); paths that do not resolve off this
// element (e.g. `answer.item` off the resource focus) contribute nothing. `B` is the builder
// handle exposing `compilePath`/`arrayize`.
export function typedSeed(paths, elem, B) {
	const parts = [];
	paths.forEach(p => {
		let resolved;
		try { resolved = B.compilePath(p, elem); } catch { return; }
		if (!resolved.type || !resolved.type.fhirType) return;
		// arrayize inline from the single compile result rather than recompiling via B.arrayize.
		parts.push(resolved.outputType.isArray ? resolved.sql : `as_list(${resolved.sql})`);
	});
	if (!parts.length) return "[]::JSON[]";
	return parts.length === 1 ? parts[0] : `list_concat(${parts.join(", ")})`;
}

// The `from_json` structure for a repeat scope: `pathsToJsonStruct` over the scope's
// column/forEach/where paths, rooted at the scope element, truncated at nested repeat seeds. The
// nav-path coverage reuses `viewPaths` (the same walker the read-schema derivation uses): a nested
// `repeat` surfaces ONLY its seed fields (each lands childless, hence raw JSON[]) so the recursive
// subtype is not expanded into a finite STRUCT — that subtree stays raw and re-enters
// `WITH RECURSIVE` under its own bridge. The body is passed with the `repeat` directive stripped so
// `viewPaths` walks it as a plain scope rooted at the element.
export function repeatStructure(repeatNode, elemSchemaPath, schema, vars) {
	const body = {column: repeatNode.column, select: repeatNode.select, unionAll: repeatNode.unionAll};
	const path = viewPaths(body);
	const ast = fhirpathToAst(path, elemSchemaPath, schema, vars);
	const tree = extractPathsFromAst({asts: [ast]});
	if (!tree.length) return "{}";
	return pathsToJsonStruct(tree);
}

// The `from_json` element structures for forced-JSON fields a scope's columns navigate (issue #35).
// When a sibling `repeat` forces a field (e.g. `item`, or the multi-segment `answer.item` of a
// QuestionnaireResponse recursion) to raw JSON[], a column navigating it (`answer.item.linkId.first()`)
// would emit JSON into its declared type. We re-type that field to a typed STRUCT element so
// navigation yields typed values — the inline form of the repeat/forEach bridge. For each forced path
// actually navigated by `columns` (rooted at `elemSeed`), returns the typed element structure of the
// leaves under it, keyed by the SAME relative dot path; recursive/forced subtrees stay raw JSON via
// `pathsToJsonStruct`, and from_json keeps only the listed keys. Paths not navigated are omitted.
export function forcedFieldStructures(columns, elemSeed, forcedFields, schema, vars) {
	if (!columns.length || !forcedFields.length) return new Map();
	const ast = fhirpathToAst(viewPaths({column: columns}), elemSeed, schema, vars);
	const tree = extractPathsFromAst({asts: [ast]});
	const out = new Map();
	forcedFields.forEach(field => {
		// Descend the navigation tree to the (possibly nested) forced field.
		const node = navigatePathTree(tree, field);
		if (node && node.children && node.children.length)
			out.set(field, pathsToJsonStruct(node.children));
	});
	return out;
}

// The element produced by iterating `pathStr` from `elem`. `B` exposes `compilePath`.
export function childElemOf(pathStr, elem, B) {
	const {type} = B.compilePath(pathStr, elem);
	return {
		ref: "_node",
		inLambda: true,
		seed: type.schemaPath,
		inputType: {fhirType: type.fhirType, isArray: false, schemaPath: type.schemaPath}
	};
}
