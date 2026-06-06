import {fhirpathToAst} from "./fhirpath-parser.js";
import {astToSql, pathsToSchema, tablesToSql, setRepeatContext} from "./ddb-sql-builder.js"
import {parseVd, extractPathsFromAst} from "./view-parser.js";
import {buildStagedQuery, makeBuilder} from "./staged-sql-builder.js";
import {typedSeed, repeatStructure, reduceSource} from "./repeat-lowering.js";
import macros from "../templates/duck-macros.js";

// Force the schema tree nodes named by resource-rooted dot paths to read as raw JSON[]
// (a repeat seed: "repeat wins" over any sibling navigation that would type the field).
function applyForcedJson(tree, paths) {
	(paths || []).forEach(pathStr => {
		let level = tree, node = null;
		for (const seg of pathStr.split(".")) {
			node = level.find(n => n.value === seg);
			if (!node) break;
			level = node.children;
		}
		if (node) { node.forceJson = true; node.children = []; }
	});
}

// The resource-rooted dot paths of each repeat seed that is reachable through typed navigation
// (a top-level repeat, or one nested under typed `forEach`es) and so must be forced to JSON[] in
// the read schema. Repeats nested inside another repeat sit under a `from_json` bridge already,
// so they are left to `repeatStructure`'s truncate-at-repeat-seed rule and not collected here.
function collectForcedJsonPaths(vd) {
	const out = [];
	const descend = (node, prefix, inRepeat) => {
		(node.select || []).forEach(c => walk(c, prefix, inRepeat));
		(node.unionAll || []).forEach(c => walk(c, prefix, inRepeat));
	};
	const walk = (node, prefix, inRepeat) => {
		if (node.repeat) {
			if (!inRepeat) node.repeat.forEach(p => out.push([...prefix, ...p.split(".")].join(".")));
			descend(node, prefix, true);
			return;
		}
		const nav = !inRepeat && (node.forEach || node.forEachOrNull);
		descend(node, nav ? [...prefix, ...nav.split(".")] : prefix, inRepeat);
	};
	walk(vd, [], false);
	return out;
}

// Build the struct-backend repeat context consumed by `astToSql`'s `_repeat` case. For a given
// `_repeat` id it rebuilds the reduce accumulator + `from_json` bridge: the seed is the typed
// navigation of the listed paths off the enclosing element (the resource for a top-level repeat,
// the enclosing `forEach`/`repeat` element otherwise), and the structure is derived from the
// repeat body, truncated at nested-repeat seeds (design D1/D4).
function makeRepeatContext(repeats, schema, vars, depth, resourceType) {
	const B = makeBuilder(schema, vars);
	// A top-level repeat seeds off the resource focus (no enclosing lambda element); a nested one
	// seeds off the enclosing `forEach`/`repeat` element bound to `rootVar`.
	const enclosing = (inputType, rootVar, inLambda) => inputType && inputType.fhirType
		? {ref: rootVar, inLambda, seed: inputType.schemaPath, inputType}
		: {ref: null, inLambda: false, seed: resourceType, inputType: {}};
	const bridge = structure => `.list_transform(rb -> from_json(rb, '${structure}'))`;
	return {
		// The reduce accumulator for a `_repeat` directive (design D1): the typed repeat elements,
		// which the caller (astToSql) then projects the body over once.
		sourceFor(id, elemSchemaPath, inputType, rootVar, inLambda) {
			const node = repeats[id];
			const seed = typedSeed(node.repeat, enclosing(inputType, rootVar, inLambda), B);
			const structure = repeatStructure(node, elemSchemaPath, schema, vars);
			return reduceSource(seed, node.repeat, structure, depth);
		},
		// The single-level typed bridge for a `_jsoneach` directive: the navigated JSON list
		// converted to typed elements, no recursion (shared-field case, design D3).
		jsonEachSource(id, elemSchemaPath, inputType, rootVar, inLambda) {
			const node = repeats[id];
			const field = node.forEach || node.forEachOrNull;
			const seed = typedSeed([field], enclosing(inputType, rootVar, inLambda), B);
			const structure = repeatStructure(node, elemSchemaPath, schema, vars);
			return `${seed}${bridge(structure)}`;
		}
	};
}

export function buildQuery(vd, schema, filterByResourceType, verbose, vars, backend="struct", rootKey="natural", repeatDepth=10) {
	const isStruct = backend !== "staged";
	const parsedVd = parseVd(vd, false, isStruct);
	if (verbose) console.log(parsedVd.path)

	const staged = backend === "staged" ? buildStagedQuery(vd, schema, vars, {rootKey}) : null;

	// On the struct path a `repeat` compiles into a `_repeat` directive that needs the FHIR schema
	// to build its reduce seed and `from_json` bridge; the context below supplies that to the
	// otherwise schema-free `astToSql` for the duration of the compile (design D4).
	const structRepeats = isStruct ? Object.keys(parsedVd.repeats) : [];
	const repeatCtx = structRepeats.length ? makeRepeatContext(parsedVd.repeats, schema, vars, repeatDepth, vd.resource) : null;

	// The parseVd transform/flattening is only consumed by the struct backend. For a staged
	// `repeat` view it is not emitted (the staged backend lowers repeat itself), and compiling
	// it can fail, so it is computed lazily only when needed.
	const fpAst = fhirpathToAst(parsedVd.path, vd.resource, schema, vars);
	let fpSql;
	if (staged && staged.hasRepeat) {
		fpSql = "";
	} else if (repeatCtx) {
		setRepeatContext(repeatCtx);
		try { fpSql = astToSql(fpAst).sql; } finally { setRepeatContext(null); }
	} else {
		fpSql = astToSql(fpAst).sql;
	}

	const whereAsts = (vd.where||[]).map(w => w.path)
		.concat([filterByResourceType ? `resourceType = '${vd.resource}'` : null])
		.filter(w => !!w)
		.map(w => fhirpathToAst(w, vd.resource, schema, vars));

	const whereSql = whereAsts.map(w => {
		const whereSql = astToSql(w);
		if (whereSql.outputType.fhirType.indexOf("boolean") != 0)
			throw new Error("where path must output a boolean value");
		return `(${whereSql.sql})`;
	}).join(" and ");

	// The staged natural-key mode keys a fork on the resource key, which the ViewDefinition
	// need not otherwise reference; include its path in the typed read schema so the key binds.
	const keyAsts = staged && staged.resourceKeyAst ? [staged.resourceKeyAst] : [];
	const schemaPaths = extractPathsFromAst({asts: [fpAst].concat(whereAsts).concat(keyAsts)});
	if (staged && staged.hasRepeat) applyForcedJson(schemaPaths, staged.forcedJsonPaths);
	if (repeatCtx) applyForcedJson(schemaPaths, collectForcedJsonPaths(vd));
	const schemaSql = pathsToSchema(schemaPaths)
	const outputSql = tablesToSql(parsedVd.tables);
	return {pathSql: fpSql, schemaSql, outputSql, whereSql, staged}
}

//TODO: consider replacing this with a full template language
export function templateToQuery(vd, schema, template, args=[], verbose, filterByResourceType, customMacros=null, vars=null, backend="struct", rootKey="natural", repeatDepth=10) {
	//Setting filterByResourceType to btrue can only be used if the schema for the
	//elements being use is compatible between all of the resources being read
	//(e.g., element with the same names have the same structure). This is used
	//in some of the tests that mix resource types.
	
	const queryParts = buildQuery(vd, schema, filterByResourceType, verbose, vars, backend, rootKey, repeatDepth);
	const whereSql = queryParts.whereSql ? "WHERE " + queryParts.whereSql : "";
	const schemaSql = queryParts.schemaSql ? `, columns=${queryParts.schemaSql}` : "";

	// Concatenate base macros with custom macros
	const allMacros = customMacros ? macros + '\n' + customMacros : macros;

	const templateVars = args.concat([
		["fq_input_dir", process.cwd()],
		["fq_output_dir", process.cwd()],
		["fq_where_filter", whereSql],
		["fq_sql_transform_expression", queryParts.pathSql + " AS result"],
		["fq_sql_input_schema", schemaSql],
		["fq_sql_flattening_cols", queryParts.outputSql.fieldSql],
		["fq_sql_flattening_tables", queryParts.outputSql.joinSql],
		["fq_vd_name", vd.name || "output"],
		["fq_vd_resource", vd.resource],
		["fq_sql_macros", allMacros],
		["fq_staged_src", queryParts.staged ? queryParts.staged.srcSelect : ""],
		["fq_staged_tail", queryParts.staged ? queryParts.staged.tail : ""],
		["fq_staged_with", queryParts.staged ? queryParts.staged.withKeyword : "WITH"],
		["fq_staged_macros", queryParts.staged ? queryParts.staged.macros : ""],
		["fq_staged_src_materialized", queryParts.staged && queryParts.staged.srcMaterialized ? "MATERIALIZED " : ""]
	]);

	templateVars.forEach( v => {
		const finder = new RegExp(`\{\{\s*${v[0]}\s*\}\}`, "g");
		template = template.replace(finder, v[1]);
	})

	return template;
}