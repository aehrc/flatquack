import {fhirpathToAst} from "./fhirpath-parser.js";
import {astToSql, pathsToSchema} from "./ddb-sql-builder.js"
import {validateVd, viewPaths, extractPathsFromAst, navigatePathTree} from "./view-parser.js";
import {buildStagedQuery} from "./staged-sql-builder.js";
import macros from "../templates/duck-macros.js";

// Force the schema tree nodes named by resource-rooted dot paths to read as raw JSON[]
// (a repeat seed: "repeat wins" over any sibling navigation that would type the field). The
// recursive FHIR type a repeat descends is not a finite STRUCT, so the seed stays raw JSON[] and
// re-enters `WITH RECURSIVE`; its body is evaluated typed through a from_json bridge instead.
function applyForcedJson(tree, paths) {
	(paths || []).forEach(pathStr => {
		// Only force-JSON when the FULL path resolves: a partial match would point at a shallower
		// ancestor, and truncating that would corrupt a typed sibling's read schema.
		const node = navigatePathTree(tree, pathStr);
		if (node) { node.forceJson = true; node.children = []; }
	});
}

export function buildQuery(vd, schema, filterByResourceType, verbose, vars, rootKey="natural") {
	validateVd(vd);

	const staged = buildStagedQuery(vd, schema, vars, {rootKey});
	if (verbose) console.log(staged.pipeline);

	const whereAsts = (vd.where||[]).map(w => w.path)
		.concat([filterByResourceType ? `resourceType = '${vd.resource}'` : null])
		.filter(w => !!w)
		.map(w => fhirpathToAst(w, vd.resource, schema, vars));

	// A where path that navigates a repeat-forced field must re-type it inline, exactly like a root
	// column (issue #35); the staged builder supplies the resource-rooted re-type map. Non-crossing
	// paths (and the resourceType filter) are unaffected — the map only fires on a forced field.
	const whereInput = staged.whereRetype ? {_retype: staged.whereRetype} : {};
	const whereSql = whereAsts.map(w => {
		const whereSql = astToSql(w, false, whereInput, "el", "0");
		if (whereSql.outputType.fhirType.indexOf("boolean") != 0)
			throw new Error("where path must output a boolean value");
		return `(${whereSql.sql})`;
	}).join(" and ");

	// The staged emitter reads typed columns, so every column / forEach path the view navigates
	// must be present in the read schema; parse the navigation expression for path extraction.
	const viewAst = fhirpathToAst(viewPaths(vd), vd.resource, schema, vars);
	// The staged natural-key mode keys a fork on the resource key, which the ViewDefinition
	// need not otherwise reference; include its path in the typed read schema so the key binds.
	const keyAsts = staged.resourceKeyAst ? [staged.resourceKeyAst] : [];
	const schemaPaths = extractPathsFromAst({asts: [viewAst].concat(whereAsts).concat(keyAsts)});
	// A repeat seed reachable through typed navigation must read as raw JSON[] ("repeat wins").
	applyForcedJson(schemaPaths, staged.forcedJsonPaths);
	const schemaSql = pathsToSchema(schemaPaths)
	return {schemaSql, whereSql, staged}
}

//TODO: consider replacing this with a full template language
export function templateToQuery(vd, schema, template, args=[], verbose, filterByResourceType, customMacros=null, vars=null, rootKey="natural") {
	//Setting filterByResourceType to btrue can only be used if the schema for the
	//elements being use is compatible between all of the resources being read
	//(e.g., element with the same names have the same structure). This is used
	//in some of the tests that mix resource types.

	const queryParts = buildQuery(vd, schema, filterByResourceType, verbose, vars, rootKey);
	const whereSql = queryParts.whereSql ? "WHERE " + queryParts.whereSql : "";
	const schemaSql = queryParts.schemaSql ? `, columns=${queryParts.schemaSql}` : "";

	// Concatenate base macros with custom macros
	const allMacros = customMacros ? macros + '\n' + customMacros : macros;

	const templateVars = args.concat([
		["fq_input_dir", process.cwd()],
		["fq_output_dir", process.cwd()],
		["fq_sql_where", whereSql],
		["fq_sql_input_schema", schemaSql],
		["fq_vd_name", vd.name || "output"],
		["fq_vd_resource", vd.resource],
		["fq_sql_macros", allMacros],
		["fq_sql_view_macros", queryParts.staged.viewMacros],
		["fq_sql_with", queryParts.staged.withKeyword],
		["fq_sql_input", queryParts.staged.inputName],
		["fq_sql_pipeline", queryParts.staged.pipeline],
		["fq_sql_output", queryParts.staged.outputName],
		["fq_sql_output_columns", queryParts.staged.outputColumns]
	]);

	templateVars.forEach( v => {
		const finder = new RegExp(`\{\{\s*${v[0]}\s*\}\}`, "g");
		template = template.replace(finder, v[1]);
	})

	return template;
}
