//a few quick validation checks
export function validateVd(vd) {
	
	function findSelect(node) {
		if (node.select) 
				return true;
		if (node.unionAll || Array.isArray(node))
			return (node.unionAll||node).find(findSelect)
	}

	function validateElement(node) {
		let output = [];
		if (node.forEach || node.forEachOrNull) {
			if (node.forEach && typeof(node.forEach) != "string")
				throw new Error("forEach elements must be a string");
			if (node.forEachOrNull && typeof(node.forEachOrNull) != "string")
				throw new Error("forEachOrNull elements must be a string");
			if (node.forEach && node.forEachOrNull)
				throw new Error("a select element may not contain both a forEach and a forEachOrNull element");
			if (!node.select && !node.column && !node.unionAll)
				throw new Error("forEach and forEachOrNull elements must be used together with a column, select or unionAll element");
		}
		
		//collection must be boolean
		if (node.select) {
			if (!Array.isArray(node.select))
				throw new Error("select elements must be an array");
			output.push( node.select.map(validateElement) );
		}

		if (node.column) {
			if (!Array.isArray(node.column))
				throw new Error("column elements must be an array");
			if (node.column.find(c => !c.name || typeof(c.name) != "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(c.name)))
				throw new Error("each column must contain a name element that matches the expression ^[A-Za-z][A-Za-z0-9_]*$");
			if (node.column.find(c => c.collection && typeof(c.collection) != "boolean"))
				throw new Error("collection elements must be true or false");
			output.push( node.column.map(c => c.name) );
		}

		if (node.unionAll) {
			if (!Array.isArray(node.unionAll))
				throw new Error("unionAll elements must be an array");
			if (findSelect(node.unionAll))
				throw new Error("Not implemented - nested select in unionAll");
			const unionItems = node.unionAll.map(u => validateElement(u).flat(Infinity))
			const first = JSON.stringify(unionItems[0]);
			const error = unionItems.slice(1).find(uc => JSON.stringify(uc) != first);
			if (error) throw new Error("columns in unionAll elements must have matching names");
			output.push(unionItems[0])
		}
		return output;
	}

	//root elements
	if (!vd.resource) 
		throw new Error("ViewDefinitions must include a resource");
	
	if (vd.name && !/^[A-Za-z][A-Za-z0-9_]*$/.test(vd.name))
		throw new Error("ViewDefinition name element must match the expression ^[A-Za-z][A-Za-z0-9_]*$");

	if (vd.where && vd.where.find(w => !w.path || typeof(w.path) != "string"))
		throw new Error("where elements must include a path string");

	//nested elements
	validateElement(vd);
}

export function parseVd(vd, skipValidation) {
	let tableIndex = 0;
	let tables = [];

	function addField(fieldName, parent) {
		if (!tables.find(t => t.fieldName == fieldName && t.type == "field" && t.parent == parent)) {
			tables.push({type: "field", parent, fieldName});
		}
	}

	function updateTable(name, allowNull) {
		tables.find(t => t.name == name).allowNull = allowNull;
	}

	function addTable(type, parent, allowNull) {
		tableIndex++;
		const name = [type[0], tableIndex].join("_");
		tables.push({type, parent, name, allowNull});
		return name;
	}

	function parseNode(node, isRoot, inUnion, parentTable) {
		// A `repeat` directive descends its listed paths recursively; the staged backend
		// evaluates the body on JSON (via from_json), so for the typed read schema we only
		// surface the seed fields — each lands childless, hence as raw JSON[] (a recursive
		// FHIR type is not a finite STRUCT). The body is not walked here.
		if (node.repeat && !isRoot) {
			return node.repeat.map(p => `_col('_rseed', ${p})`).join(", ");
		}

		if (node.forEach || node.forEachOrNull) {
			const eachTable = !inUnion ? addTable(node.forEach ? "each" : "nullEach", parentTable, !!node.forEachOrNull) : parentTable;
			if (inUnion && node.forEachOrNull) updateTable(eachTable, true);
			const rest = parseNode({...node, forEach: undefined, forEachOrNull: undefined}, false, false, eachTable);
			const path = `${node.forEach || node.forEachOrNull}.${node.forEachOrNull ? "_forEachOrNull" : "_forEach"}(${rest})`;
			return !inUnion ? `_col_collection('${eachTable}', ${path})` : path;
		}

		let output = [];
		if (node.column) {
			node.column.forEach( c => addField(c.name, parentTable) );
			const columns = node.column.map( c => `_col${c.collection ? "_collection" : ""}('${c.name}', ${c.path||c.name})` );
			output.push(inUnion ? `_forEach(${columns})` : columns);
		}

		if (node.select) {
			const path = node.select.map( n => parseNode(n, false, false, parentTable) );
			// output.push(isRoot ? `_forEach(${path.join(", ")})` : path);
			output.push(isRoot || inUnion ? `_forEach(${path.join(", ")})` : path);
		}
		
		if (node.unionAll) {
			const parentTableDefinition = tables.find(t => t.name == parentTable)
			const unionTable = !inUnion ? addTable("union", parentTable, parentTableDefinition && parentTableDefinition.allowNull) : parentTable;
			const path = node.unionAll.map(n => parseNode(n, false, true, unionTable));
			const unionPath = inUnion
				? `_unionAll(${path.join(", ")})`
				: `_col_collection('${unionTable}', _unionAll(${path.join(", ")}))`;
			output.push(isRoot ? `_forEach(${unionPath})` : unionPath);
		}

		return output.join(", ");
	}

	if (!skipValidation) validateVd(vd);
	const path = parseNode(vd, true);
	return {path, tables}
}

export function extractPathsFromAst(node) {

	let paths = [];
	function addPath(path) {
		let position = paths;
		path.forEach(segment => {
			const current = position.find(p => p.value == segment.value);
			if (!current) {
				position.push(segment);
				position = segment.children;
			} else {
				position = current.children;
			}
		});
	}

	function extractPaths(root, path=[]) {
		let queue = [root];		
		while (queue.length > 0) {
			const current = queue.shift();
			if (current.segmentType == "nav") {
				path.push({value: current.value, fhirType: current.type.fhirType, isArray: current.type.isArray, children:[]});
			} else if (Array.isArray(current)||current.children) {
				queue = queue.concat(current.children||current);
			} else if (current.args) {
				current.args.forEach(a => extractPaths(a, path.slice()))
			} else if (current.asts) {
				current.asts.forEach(p => extractPaths(p, []))
			}
		}
		addPath(path)
	}

	extractPaths(node);
	return paths;
}