export function tablesToSql(tables) {

	const fieldSql = tables.filter(t => t.type == "field")
		.map(t => `${t.parent||"result"}.${t.fieldName}`)
		.join(", ");
	
	const joinSql = tables.map( (t,i) => {
		if (t.type == "nullEach" || t.allowNull) {
			return `LEFT JOIN UNNEST(${t.parent||"result"}.${t.name}) AS l_${i}(${t.name}) ON TRUE`;
		} else if (t.type == "each" || t.type == "repeat" || (t.type == "union" && !t.allowNull)) {
			return `CROSS JOIN UNNEST(${t.parent||"result"}.${t.name}) AS f_${i}(${t.name})`;
		}
		
	}).filter(t => !!t).join(" ")

	return {fieldSql, joinSql};

}

// Reserved lambda variable for `list_transform`/`list_filter` lambdas. It must never be a
// scope element `rootVar` (which are "node", root "", or the repeat from_json bridge "el"),
// so a lambda parameter can never collide with the element it is applied to — DuckDB would
// otherwise resolve `el.field` inside the lambda against an outer column also named `el`.
const L = "__el";

// Reserved index variable paired with `L` for the indexed `list_transform` lambda that realizes a
// `forEach`/`forEachOrNull`/`repeat` iteration. DuckDB's index parameter is 1-based, so `%rowIndex`
// binds to `(__idx - 1)`. Nested iterations reuse the name; lexical shadowing keeps each level's
// index correct, exactly as the reused `__el` element variable already relies on.
const IDX = "__idx";

// `repeat` lowering on the struct path needs the FHIR schema (to build the reduce seed and the
// `from_json` bridge structure), which `astToSql` does not have. The orchestrator (query-builder)
// computes a context exposing `sourceFor(id, elemSchemaPath, inputType, rootVar, inLambda)` —
// returning the reduce-accumulator + typed-bridge SQL for a `_repeat` directive — and installs it
// here for the duration of one compile (design D4). `null` means there are no repeats to lower.
let repeatCtx = null;
export function setRepeatContext(ctx) { repeatCtx = ctx; }

// `rowIndexSql` carries the SQL for the current `%rowIndex` — the 0-based position within the
// nearest enclosing iteration. It defaults to "0" (no enclosing iteration: resource root, or a
// non-iterating projection branch). A real `_forEach`/`_forEachOrNull`/`_repeat` rebinds it to
// `(<lambda index> - 1)` for its body; a `_project` wrapper passes it through unchanged.
export function astToSql(node, inLambda, inputType={}, rootVar="el", rowIndexSql="0") {

	function flattenSql(querySegments) {
		if (!querySegments) return;
		if (!Array.isArray(querySegments)) querySegments = [querySegments];
		//group nav path items with parens
		let inNav;
		querySegments.map( (s,i) => {
			const nextIsNav = querySegments[i+1] && querySegments[i+1].outputType && querySegments[i+1].outputType.isNav;
			if (s.outputType && s.outputType.isNav && !inNav && nextIsNav) {
				s.sql = "(" + s.sql;
				inNav = true;
			} else if (inNav && !nextIsNav) {
				s.sql = s.sql + ")";
				inNav = false;
			}
		})
		return {
			sql: querySegments.map(s => s && s.sql).filter(s => !!s).join("."),
			outputType: querySegments.at(-1).outputType
		}
	}

	if (Array.isArray(node)) {
		let prevOutputType = inputType;
		const outputSql = node.map(n => {
			const query = astToSql(n, inLambda, prevOutputType, rootVar, rowIndexSql);
			//only treat first element of a navigation array as in lambda (prefixed with 'el')
			if (inLambda) inLambda = false; 
			if (query) prevOutputType = query.outputType;
			return query;
		});
		return outputSql;
	}

	let sql;
	let outputType;

	switch (node.segmentType) {

		//nodes with children
		case 'expr':
		case 'paren':
			const children = Array.isArray(node.children) ? node.children : [node.children];
			const query = flattenSql( astToSql(children, inLambda, inputType, rootVar, rowIndexSql) );
			return {
				sql: node.segmentType == "paren" ? `(${query.sql})` : query.sql,
				outputType: query.outputType
			}; 

		case 'nav':
			if (inLambda) {
				sql = `(${rootVar}.${node.value})`
				outputType = {fhirType: node.type.fhirType, isArray: node.type.isArray, isNav: false, schemaPath: node.type.schemaPath}
			} else if (inputType.fhirType && inputType.isArray) {
				sql = `list_transform(${L} -> ${L}.${node.value})${node.type.isArray ? ".flatten()" : ""}`;
				outputType = {fhirType: node.type.fhirType, isArray: true, isNav: false, schemaPath: node.type.schemaPath}
			} else {
				sql = node.value;
				outputType = {fhirType: node.type.fhirType, isArray: node.type.isArray, isNav: true, schemaPath: node.type.schemaPath};
			}
			return {sql, outputType}

		case 'literal':
			sql = node.type.fhirType != "dateTime" ? node.value : `(TIMESTAMP '${node.value.replace("T", " ")}')`
			return {sql, outputType: {fhirType: node.type.fhirType, isArray: false}};

		// `%rowIndex`: the 0-based position within the nearest enclosing iteration, threaded as
		// `rowIndexSql` (bound to `(__idx - 1)` by an enclosing `_forEach`/`_repeat`, else "0").
		case 'rowIndex':
			return {sql: rowIndexSql, outputType: {fhirType: "integer", isArray: false}};

		//and, or, add, subtract, multiply
		case 'components':
			const components = node.args.map( c => {
				return flattenSql( astToSql(c, inLambda, {}, rootVar, rowIndexSql) );
			});
			sql = components.map(c => c.sql).join(` ${node.operator} `);
			outputType = {fhirType: node.type.fhirType == "number" ? "number" : "boolean_expr", isArray: false}
			return {sql, outputType}

		//equality, inequality
		case 'comparison':
			let leftQuery = astToSql(node.args[0], inLambda, inputType, rootVar, rowIndexSql);
			let leftIsArray = leftQuery.at(-1).outputType.isArray
			let rightQuery = astToSql(node.args[1], inLambda, inputType, rootVar, rowIndexSql);
			let rightIsArray = rightQuery.at(-1).outputType.isArray;
			if (rightIsArray && !leftIsArray) {
				[rightQuery, leftQuery] = [leftQuery, rightQuery];
				[rightIsArray, leftIsArray] = [leftIsArray, rightIsArray];
			}

			if (!leftIsArray) {
				sql = ["(", flattenSql(leftQuery).sql, node.operator, flattenSql(rightQuery).sql, ")"].join(" ");
			} else {
				sql = ["(",
					`(${flattenSql(leftQuery).sql}).list_transform(${L} -> ${L} ${node.operator} (${flattenSql(rightQuery).sql})).list_bool_and()`,
				")"].join("");
			}
			return {sql, outputType: {fhirType: "boolean_expr", isArray: false}};

		case 'this':
			return {
				sql: inLambda ? rootVar : "",
				outputType: inputType
			}

		case 'fn':
			const firstArg = node.args[0] && node.args[0][0];
			// inputType ||= {fhirType:undefined}
			switch (node.name) {
				case 'slice':
					return {
						sql: `slice(${firstArg.value})`, 
						outputType: {fhirType: inputType.fhirType, isArray: false}
					};

				case 'join':
					sql = `list_aggregate('string_agg', ${(firstArg && firstArg.value) || "''"}).ifnull2('')`;
					return {sql, outputType: {fhirType: "string", isArray: false}}
				
				case 'where':
					if (inputType && inputType.isArray) {
						sql = `list_filter(${L} -> ${flattenSql(astToSql(firstArg, true, {}, L, rowIndexSql)).sql})`;
						outputType = {fhirType: inputType.fhirType, isArray: true}
					} else if (inputType.fhirType) {
						sql = `as_list().list_filter(${L} -> ${flattenSql(astToSql(firstArg, true, {}, L, rowIndexSql)).sql}).slice(1)`;
						outputType = {fhirType: inputType.fhirType, isArray: false}
					} else {
						sql = flattenSql(astToSql(firstArg, undefined, {}, rootVar, rowIndexSql)).sql;
						outputType = {fhirType: "boolean_expr", isArray: false}
					}
					return {sql, outputType}

				case 'not':
					sql = inputType.isArray
						? "list_bool_and.is_false()"
						: "is_false()";
					return {sql, outputType: {isArray: false, fhirType: "boolean_expr"}}
	
				case 'exists':
					if (inputType.isArray) {
						const sqlExpr = inputType.fhirType == "boolean_expr" ? " = true" : "IS NOT NULL";
						sql = `list_filter(${L} -> ${L} ${sqlExpr}).ifnull2([]).len() > 0`
					} else {
						sql = inputType.fhirType == "boolean_expr" ? "is_true()" : "is_not_null()";
					}
					return {sql, outputType: {isArray: false, fhirType: "boolean_expr"}}

				case 'empty':
					if (inputType.isArray && inputType.fhirType != "boolean_expr") {
						sql = `ifnull2([NULL]).list_filter(${L} -> ${L} IS NOT NULL).len() = 0`;
					} else if (inputType.isArray && inputType.fhirType == "boolean_expr"){
						sql = `ifnull2([false]).list_filter(${L} -> ${L} = true).len() = 0`;
					} else {
						sql = inputType.fhirType == "boolean_expr" ? "is_false()" : "is_null()";
					} 
					return {sql, outputType: {isArray: false, fhirType: "boolean_expr"}}

				//non-standard
				case '_splitPath':
					return inputType && inputType.isArray
						? {
							sql: `list_transform(${L} -> ${L}.parse_path('/')[${firstArg.value}])`,
							outputType: {isArray: true, fhirType: "string"}
						}
						: {
							sql: `${inLambda ? rootVar + "." : ""}parse_path('/')[${firstArg.value}]`,
							outputType: {isArray: false, fhirType: "string"}
						}

				//non-standard
				case '_col':
				case '_col_collection':
					const colName = firstArg.value;
					const colValue = node.args[1].at(-1);
					let colValueSql = flattenSql(astToSql(node.args[1], inLambda, inputType, rootVar, rowIndexSql));
					
					// This validation can only really be run at runtime since a collection that happens
					// to have one value is treated as a non-collection and doesn't need the collection tag. 
					// if (node.name != "_col_collection" && colValueSql.outputType.isArray)
					// 	throw new Error("path in columns with collection set to true must return a collection");

					if (node.name == "_col_collection" && !colValueSql.outputType.isArray)
						throw new Error("path in columns with collection set to false must not return a collection");

					//if array of non-array type then slice by default (should this be a setting?)
					if (colValue.segmentType == "nav" && colValueSql.outputType.isArray && node.name !== "_col_collection") {
							colValueSql.sql += ".as_value()"
					} else if (node.name == "_col_collection") {
						colValueSql.sql += ".ifnull2([])"
					}
					return {sql: `${colName}: ${colValueSql.sql}`, outputType: colValueSql.outputType};
			
				//non-standard
				case '_forEach':
				case '_forEachOrNull':

					//TODO: error if each arg is not a col function
					// A real iteration: the indexed `list_transform` lambda binds `%rowIndex` to
					// `(__idx - 1)` for the body. `forEachOrNull` pads the SOURCE (`ifnull2([NULL])`
					// BEFORE the transform) so the synthesized null row flows through the lambda and
					// reports %rowIndex = 0, instead of being appended after it (design D4).
					// Cast to INTEGER: DuckDB's `list_transform` index is BIGINT, but `%rowIndex` is an
					// `integer` (and a BIGINT round-trips to a JS BigInt, breaking value equality).
					const childRowIndex = `((${IDX} - 1)::INTEGER)`;
					const nullPad = node.name == "_forEachOrNull" ? "ifnull2([NULL])." : "";

					if (!inputType.fhirType) {
						// No typed collection to iterate (unresolved field type): no list is produced,
						// so there is no iteration index and `%rowIndex` stays 0.
						const cols = node.args.map(a => astToSql(a, inLambda, inputType, rootVar, "0")).map(flattenSql).map(a => a.sql).join(",");
						sql = `{${cols}}`;
						outputType = {fhirType: inputType.fhirType, isArray: false};
					} else {
						const cols = node.args.map(a => astToSql(a, true, inputType, L, childRowIndex)).map(flattenSql).map(a => a.sql).join(",");
						const pre = !inputType.isArray
							? `as_list().${nullPad}`
							: (inLambda ? `${rootVar}.as_list().${nullPad}` : nullPad);
						sql = `${pre}list_transform((${L}, ${IDX}) -> {${cols}})`;
						outputType = {fhirType: inputType.fhirType, isArray: true};
					}
					return {sql, outputType}

				//non-standard
				// A column projection at a scope (resource root, `select`, or a `unionAll` branch) —
				// NOT an iteration. Same row shape as `_forEach`, but it does NOT open a new
				// `%rowIndex` scope: the enclosing `rowIndexSql` is passed through unchanged (0 at the
				// root; the enclosing forEach's index for a non-iterating union branch). The
				// single-element `as_list().list_transform` wrapper here is structural, so its lambda
				// position must never be mistaken for an iteration index.
				case '_project':
					if (!inputType.fhirType) {
						const cols = node.args.map(a => astToSql(a, inLambda, inputType, rootVar, rowIndexSql)).map(flattenSql).map(a => a.sql).join(",");
						sql = `{${cols}}`;
						outputType = {fhirType: inputType.fhirType, isArray: false};
					} else if (!inputType.isArray) {
						const cols = node.args.map(a => astToSql(a, true, inputType, L, rowIndexSql)).map(flattenSql).map(a => a.sql).join(",");
						sql = `as_list().list_transform(${L} -> {${cols}})`;
						outputType = {fhirType: inputType.fhirType, isArray: true};
					} else {
						const cols = node.args.map(a => astToSql(a, true, inputType, L, rowIndexSql)).map(flattenSql).map(a => a.sql).join(",");
						sql = `${inLambda ? rootVar + ".as_list()." : ""}list_transform(${L} -> {${cols}})`;
						outputType = {fhirType: inputType.fhirType, isArray: true};
					}
					return {sql, outputType}

				//non-standard
				case '_repeat':
					// `_repeat('id', <firstPath>._forEach(<body>))`: a `repeat` lowered as a forEach
					// whose source list is a bounded `list_reduce` accumulator over a JSON node,
					// bridged to typed elements via an inline `from_json` (design D1). The body is the
					// existing `_forEach` machinery, re-rooted (by fhirpathToAst) at the repeat element
					// type. The schema-dependent reduce+bridge wrapper comes from `repeatCtx`.
					if (!repeatCtx) throw new Error("repeat encountered without a repeat context");
					const repeatId = firstArg.value.replace(/^['"]|['"]$/g, "");
					const repeatArg = node.args[1];                       // [..nav.., _forEach fn]
					const forEachFn = repeatArg.at(-1);
					const elemTypeNode = repeatArg[repeatArg.length - 2].type;  // last seed nav's type
					const elemSchemaPath = elemTypeNode.schemaPath;
					// An unresolved seed type (e.g. a path absent from the resource) still needs the
					// list_transform body branch, not the no-type bare-struct branch; the seed is empty
					// so the body never runs, but the SQL must stay a valid list expression.
					const repeatElemType = {fhirType: elemTypeNode.fhirType || "BackboneElement", isArray: true, schemaPath: elemSchemaPath};
					// `list_transform(__el -> {<body cols>})` — projects the typed repeat elements
					// once, after the reduce (the accumulator carries typed elements, not output rows).
					const repeatSource = repeatCtx.sourceFor(repeatId, elemSchemaPath, inputType, rootVar, inLambda);
					const repeatBody = flattenSql(astToSql([forEachFn], false, repeatElemType, L, rowIndexSql)).sql;
					return {
						sql: `${repeatSource}.${repeatBody}`,
						outputType: {fhirType: elemTypeNode.fhirType, isArray: true, schemaPath: elemSchemaPath}
					};

				//non-standard
				case '_jsoneach':
					// A `forEach` over a field a sibling `repeat` forces to JSON[] (shared-field case,
					// design D3): one descent level (no reduce), the navigated JSON list bridged to
					// typed elements via `from_json`, then the existing forEach body machinery.
					if (!repeatCtx) throw new Error("jsoneach encountered without a repeat context");
					const jeId = firstArg.value.replace(/^['"]|['"]$/g, "");
					const jeArg = node.args[1];                           // [..nav.., _forEach fn]
					const jeFn = jeArg.at(-1);
					const jeTypeNode = jeArg[jeArg.length - 2].type;
					const jeSchemaPath = jeTypeNode.schemaPath;
					const jeElemType = {fhirType: jeTypeNode.fhirType || "BackboneElement", isArray: true, schemaPath: jeSchemaPath};
					const jeSource = repeatCtx.jsonEachSource(jeId, jeSchemaPath, inputType, rootVar, inLambda);
					const jeBody = flattenSql(astToSql([jeFn], false, jeElemType, L, rowIndexSql)).sql;
					return {
						sql: `${jeSource}.${jeBody}`,
						outputType: {fhirType: jeTypeNode.fhirType, isArray: true, schemaPath: jeSchemaPath}
					};

				//non-standard
				case '_unionAll':
					const unions = node.args.map(a => {
						const flat = flattenSql(astToSql(a, inLambda, inputType, rootVar, rowIndexSql));
						const arraySql = flat.outputType.isArray
							? `coalesce(${flat.sql}, [])`
							: `[${flat.sql}]`;
						return {
							sql: arraySql,
							outputType: {...flat.outputType, isArray: true}
						}
					});
					return {
						sql: unions.map(u => u.sql).join(" || "), 
						outputType: unions.length ? unions[0].outputType : {isArray: true}
					};

				//non-standard
				case '_invoke':
					const macroName = firstArg.value.replace(/^['"]|['"]$/g, ''); // Remove quotes
					
					// Validate that all parameters (except the first, which is the macro name) are scalar values
					// or arrays of scalar values. No paths are allowed.
					function validateMacroParam(argNodes, paramIndex) {
						if (!argNodes || argNodes.length === 0) return;
						
						for (const node of argNodes) {
							// Check if it's an expression wrapper
							if (node.segmentType === 'expr' && node.children) {
								validateMacroParam(node.children, paramIndex);
								continue;
							}
							
							// Only literals are allowed as parameters
							if (node.segmentType !== 'literal') {
								throw new Error(
									`_invoke parameter ${paramIndex + 1} must be a scalar literal value (string, number, boolean). ` +
									`Paths and other expressions are not allowed. Found: ${node.segmentType}`
								);
							}
						}
					}
					
					// Validate all parameters after the macro name
					node.args.slice(1).forEach((argNodes, index) => {
						validateMacroParam(argNodes, index);
					});
					
					// Process additional parameters (skip the first arg which is the macro name)
					const macroParams = node.args.slice(1).map(argNodes => {
						const argAst = flattenSql(astToSql(argNodes, false, inputType, rootVar, rowIndexSql));
						return argAst.sql;
					}).join(', ');
					
					if (inputType.isArray) {
						// Macros on array: map over each element
						sql = `list_transform(${L} -> ${L}.${macroName}(${macroParams}))`;
						outputType = {fhirType: inputType.fhirType, isArray: true};
					} else {
						// Macros on scalar: call the function directly
						sql = `${macroName}(${macroParams})`;
						outputType = {fhirType: inputType.fhirType, isArray: false};
					}
					return {sql, outputType};

				default:
					throw(`function ${JSON.stringify(node)} not handled`)
			}

			default:
				throw(`${JSON.stringify(node)} not handled`)
	}
}

// Map a leaf path node to its DuckDB scalar SQL type (no array indicator).
function leafSqlType(node) {
	if (node.fhirType == "decimal") return "DOUBLE";
	if (["boolean", "integer"].indexOf(node.fhirType) > -1) return node.fhirType.toUpperCase();
	if (node.fhirType && node.fhirType[0] != node.fhirType[0].toUpperCase()) return "VARCHAR";
	return "JSON";
}

export function pathsToSchema(node, isInRoot=true) {
	if (Array.isArray(node)) {
		const schema = node.map(n => pathsToSchema(n, isInRoot)).join(", ");
		return (isInRoot) ? `{ ${schema} }` : schema;
	}

	const arrayIndicator = node.isArray ? "[]" : "";
	let sqlType;
	// A repeat seed is read as a raw JSON list (a recursive FHIR type is not a finite STRUCT);
	// it forces JSON regardless of any sibling navigation that would otherwise type it.
	if (node.forceJson) {
		sqlType = `JSON${arrayIndicator}`;
		return isInRoot ? `${node.value}: '${sqlType}'` : `${node.value} ${sqlType}`;
	}
	if (!node.fhirType) console.log(`${JSON.stringify(node)} is of an unknown type`)
	if (node.children.length) {
		sqlType = `STRUCT(${node.children.map(c => pathsToSchema(c, false)).join(", ")})${arrayIndicator}`
	} else if (node.fhirType == "decimal") {
		sqlType = `DOUBLE${arrayIndicator}`;
	} else if (["boolean", "integer"].indexOf(node.fhirType) > -1) {
		sqlType = `${node.fhirType.toUpperCase()}${arrayIndicator}`;
	} else if (node.fhirType && node.fhirType[0] != node.fhirType[0].toUpperCase()) {
		sqlType = `VARCHAR${arrayIndicator}`;
	} else {
		sqlType = `JSON${arrayIndicator}`;
	}
	return isInRoot ? `${node.value}: '${sqlType}'` : `${node.value} ${sqlType}`
};

// Render a path tree as a `from_json` structure (the JSON-object form `from_json` accepts:
// objects are `{"f":T,...}`, arrays of objects are `[{...}]`, scalar/JSON leaves are quoted
// type strings like `"VARCHAR"`, `"VARCHAR[]"`, `"JSON[]"`). Truncated/childless complex
// nodes (notably nested-repeat seeds) become `"JSON[]"`, matching the truncate-at-repeat-seed
// schema rule and keeping those subtrees raw so they can re-enter `WITH RECURSIVE`.
export function pathsToJsonStruct(node, isInRoot=true) {
	if (Array.isArray(node)) {
		const fields = node.map(n => `${JSON.stringify(n.value)}:${pathsToJsonStruct(n, false)}`).join(",");
		return `{${fields}}`;
	}

	const arr = node.isArray;
	let typeStr;
	if (!node.forceJson && node.children && node.children.length) {
		const inner = `{${node.children.map(c => `${JSON.stringify(c.value)}:${pathsToJsonStruct(c, false)}`).join(",")}}`;
		typeStr = arr ? `[${inner}]` : inner;
	} else {
		const scalar = node.forceJson ? "JSON" : leafSqlType(node);
		typeStr = JSON.stringify(`${scalar}${arr ? "[]" : ""}`);
	}
	return isInRoot ? `{${JSON.stringify(node.value)}:${typeStr}}` : typeStr;
};
