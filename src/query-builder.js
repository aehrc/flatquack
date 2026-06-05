import {fhirpathToAst} from "./fhirpath-parser.js";
import {astToSql, pathsToSchema, tablesToSql} from "./ddb-sql-builder.js"
import {parseVd, extractPathsFromAst} from "./view-parser.js";
import {buildStagedQuery} from "./staged-sql-builder.js";
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

export function buildQuery(vd, schema, filterByResourceType, verbose, vars, backend="struct", rootKey="natural") {
	const parsedVd = parseVd(vd);
	if (verbose) console.log(parsedVd.path)

	const staged = backend === "staged" ? buildStagedQuery(vd, schema, vars, {rootKey}) : null;

	// The parseVd transform/flattening is only consumed by the struct backend. For a staged
	// `repeat` view it is not emitted (the staged backend lowers repeat itself), and compiling
	// it can fail, so it is computed lazily only when needed.
	const fpAst = fhirpathToAst(parsedVd.path, vd.resource, schema, vars);
	const fpSql = (staged && staged.hasRepeat) ? "" : astToSql(fpAst).sql;

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
	const schemaSql = pathsToSchema(schemaPaths)
	const outputSql = tablesToSql(parsedVd.tables);
	return {pathSql: fpSql, schemaSql, outputSql, whereSql, staged}
}

//TODO: consider replacing this with a full template language
export function templateToQuery(vd, schema, template, args=[], verbose, filterByResourceType, customMacros=null, vars=null, backend="struct", rootKey="natural") {
	//Setting filterByResourceType to btrue can only be used if the schema for the
	//elements being use is compatible between all of the resources being read
	//(e.g., element with the same names have the same structure). This is used
	//in some of the tests that mix resource types.
	
	const queryParts = buildQuery(vd, schema, filterByResourceType, verbose, vars, backend, rootKey);
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