// `rowIndexSql` carries the SQL for the current `%rowIndex` — the 0-based position within the
// nearest enclosing iteration. It defaults to "0" (no enclosing iteration: resource root, or a
// non-iterating projection branch). A `forEach`/`forEachOrNull` stage rebinds it to its
// per-iteration ordinal minus 1; threaded unchanged through every nested leaf expression.
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
				outputType = {fhirType: node.type.fhirType, isArray: node.type.isArray, isNav: false}
			} else if (inputType.fhirType && inputType.isArray) {
				sql = `list_transform(el -> el.${node.value})${node.type.isArray ? ".flatten()" : ""}`;
				outputType = {fhirType: node.type.fhirType, isArray: true, isNav: false}
			} else {
				sql = node.value;
				outputType = {fhirType: node.type.fhirType, isArray: node.type.isArray, isNav: true};
			}
			// Issue #35 (universal): a field a sibling `repeat` forced to raw JSON[] is re-typed to its
			// declared structure here, so navigation off it yields typed values rather than JSON — the
			// inline form of the structural bridge the repeat/forEach paths use (all three sites share
			// the `from_json` cast macro; see `castMacroFor`). `_retype` is keyed by path RELATIVE to the
			// scope element (e.g. `answer.item`); it rides on the element `inputType` and is propagated
			// down each matched segment onto the navigated `outputType`, so the cast fires at the exact
			// depth where the physical JSON diverges from the declared type — not only the first segment.
			// A path that crosses several forced boundaries re-types at each. Method-append form
			// (`<expr>.macro(...)`) so the cast composes whether the field heads the path or is deeper.
			const retypes = inputType._retype;
			if (retypes) {
				const castMac = retypes[node.value];
				if (typeof castMac === "string")
					sql = outputType.isArray ? `${sql}.list_transform(x -> ${castMac}(x))` : `${sql}.${castMac}()`;
				const descPrefix = node.value + ".";
				const descRetypes = {};
				for (const k in retypes)
					if (k.startsWith(descPrefix)) descRetypes[k.slice(descPrefix.length)] = retypes[k];
				if (Object.keys(descRetypes).length) outputType = {...outputType, _retype: descRetypes};
			}
			return {sql, outputType}

		case 'literal':
			sql = node.type.fhirType != "dateTime" ? node.value : `(TIMESTAMP '${node.value.replace("T", " ")}')`
			return {sql, outputType: {fhirType: node.type.fhirType, isArray: false}};

		// `%rowIndex`: the 0-based position within the nearest enclosing iteration, threaded as
		// `rowIndexSql` (bound to the iteration ordinal minus 1 by an enclosing forEach/forEachOrNull;
		// to a pre-order descent window by an enclosing `repeat`; else "0" at the resource root / a
		// non-iterating branch). A `null` binding means the scope cannot supply a position — guard
		// against silently emitting a constant if a scope ever reaches the leaf engine without one.
		case 'rowIndex':
			if (rowIndexSql == null)
				throw new Error("%rowIndex referencing a scope with no defined iteration position");
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
					`(${flattenSql(leftQuery).sql}).list_transform(el -> el ${node.operator} (${flattenSql(rightQuery).sql})).list_bool_and()`,
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
					// join() over an empty collection yields empty (NULL), not "" — do not coerce.
					sql = `list_aggregate('string_agg', ${(firstArg && firstArg.value) || "''"})`;
					return {sql, outputType: {fhirType: "string", isArray: false}}
				
				case 'where':
					if (inputType && inputType.isArray) {
						sql = `list_filter(el -> ${flattenSql(astToSql(firstArg, true, {}, "el", rowIndexSql)).sql})`;
						outputType = {fhirType: inputType.fhirType, isArray: true}
					} else if (inputType.fhirType) {
						sql = `as_list().list_filter(el -> ${flattenSql(astToSql(firstArg, true, {}, "el", rowIndexSql)).sql}).slice(1)`;
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
						sql = `list_filter(el -> el ${sqlExpr}).ifnull2([]).len() > 0`					
					} else {
						sql = inputType.fhirType == "boolean_expr" ? "is_true()" : "is_not_null()";
					}
					return {sql, outputType: {isArray: false, fhirType: "boolean_expr"}}

				case 'empty':
					if (inputType.isArray && inputType.fhirType != "boolean_expr") {
						sql = "ifnull2([NULL]).list_filter(el -> el IS NOT NULL).len() = 0";				
					} else if (inputType.isArray && inputType.fhirType == "boolean_expr"){
						sql = "ifnull2([false]).list_filter(el -> el = true).len() = 0";
					} else {
						sql = inputType.fhirType == "boolean_expr" ? "is_false()" : "is_null()";
					} 
					return {sql, outputType: {isArray: false, fhirType: "boolean_expr"}}

				//non-standard
				case '_splitPath':
					return inputType && inputType.isArray
						? {
							sql: `list_transform(el -> el.parse_path('/')[${firstArg.value}])`,
							outputType: {isArray: true, fhirType: "string"}
						}
						: {
							sql: `${inLambda ? "el." : ""}parse_path('/')[${firstArg.value}]`, 
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
						sql = `list_transform(el -> el.${macroName}(${macroParams}))`;
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

// The scalar SQL type a leaf path node reads as. A non-primitive (uppercase) FHIR type, or a
// node with no resolved type, falls back to raw JSON.
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
	} else {
		// Diagnostic only: a node without a resolved FHIR type still gets a best-effort SQL type.
		// Warn on stderr — the compiled SQL goes to stdout, so logging here must not pollute it.
		if (!node.fhirType) console.warn(`${JSON.stringify(node)} is of an unknown type`);
		sqlType = node.children.length
			? `STRUCT(${node.children.map(c => pathsToSchema(c, false)).join(", ")})${arrayIndicator}`
			: `${leafSqlType(node)}${arrayIndicator}`;
	}
	return isInRoot ? `${node.value}: '${sqlType}'` : `${node.value} ${sqlType}`
};

// Render a path tree as a `from_json` structure (the JSON-object form `from_json` accepts:
// objects are `{"f":T,...}`, arrays of objects are `[{...}]`, scalar/JSON leaves are quoted
// type strings like `"VARCHAR"`, `"VARCHAR[]"`, `"JSON[]"`). Truncated/childless complex
// nodes (notably nested-repeat seeds) become `"JSON[]"`, matching the truncate-at-repeat-seed
// schema rule and keeping those subtrees raw so they can re-enter `WITH RECURSIVE`.
export function pathsToJsonStruct(node, isInRoot=true) {
	const objOf = nodes => `{${nodes.map(n => `${JSON.stringify(n.value)}:${pathsToJsonStruct(n, false)}`).join(",")}}`;
	if (Array.isArray(node)) return objOf(node);

	const arr = node.isArray;
	let typeStr;
	if (!node.forceJson && node.children && node.children.length) {
		const inner = objOf(node.children);
		typeStr = arr ? `[${inner}]` : inner;
	} else {
		const scalar = node.forceJson ? "JSON" : leafSqlType(node);
		typeStr = JSON.stringify(`${scalar}${arr ? "[]" : ""}`);
	}
	return isInRoot ? `{${JSON.stringify(node.value)}:${typeStr}}` : typeStr;
};
