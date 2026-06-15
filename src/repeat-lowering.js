import {fhirpathToAst} from "./fhirpath-parser.js";
import {pathsToJsonStruct} from "./ddb-sql-builder.js";
import {extractPathsFromAst} from "./view-parser.js";

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
		if (resolved.type && resolved.type.fhirType) parts.push(B.arrayize(p, elem));
	});
	if (!parts.length) return "[]::JSON[]";
	return parts.length === 1 ? parts[0] : `list_concat(${parts.join(", ")})`;
}

// A resource-rooted FHIRPath expression covering a repeat body's navigations, rooted at the
// repeat-scope element. Mirrors `viewPaths` but: it walks the body sans the `repeat` directive,
// and a nested `repeat` inside the body surfaces ONLY its seed fields (each lands childless, hence
// raw JSON[]) so the recursive subtype is not expanded into a finite STRUCT — that subtree stays
// raw and re-enters `WITH RECURSIVE` under its own bridge.
function repeatBodyPaths(node) {
	if (node.repeat) {
		// nested repeat: surface the seed fields only (childless navs -> JSON[])
		return `_nav(${node.repeat.join(", ")})`;
	}
	if (node.forEach || node.forEachOrNull) {
		const rest = repeatBodyPaths({...node, forEach: undefined, forEachOrNull: undefined});
		return `${node.forEach || node.forEachOrNull}._nav(${rest})`;
	}
	const parts = [];
	if (node.column) parts.push(...node.column.map(c => c.path || c.name));
	if (node.select) parts.push(...node.select.map(repeatBodyPaths));
	if (node.unionAll) parts.push(...node.unionAll.map(repeatBodyPaths));
	return `_nav(${parts.join(", ")})`;
}

// The `from_json` structure for a repeat scope: `pathsToJsonStruct` over the scope's
// column/forEach/where paths, rooted at the scope element, truncated at nested repeat seeds.
export function repeatStructure(repeatNode, elemSchemaPath, schema, vars) {
	const body = {column: repeatNode.column, select: repeatNode.select, unionAll: repeatNode.unionAll};
	const path = repeatBodyPaths(body);
	const ast = fhirpathToAst(path, elemSchemaPath, schema, vars);
	const tree = extractPathsFromAst({asts: [ast]});
	if (!tree.length) return "{}";
	return pathsToJsonStruct(tree);
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
