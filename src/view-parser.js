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

// Build a single resource-rooted FHIRPath expression that nests every navigation a
// ViewDefinition performs (forEach / forEachOrNull steps wrapping their column paths, and
// unionAll branches). The staged emitter reads typed columns, so this expression — parsed by
// `fhirpathToAst` and walked by `extractPathsFromAst` — supplies the read schema's path
// coverage. It is schema coverage only: no flattening tables / join machinery is produced.
export function viewPaths(vd) {

	function parseNode(node, isRoot, inUnion) {
		if (node.forEach || node.forEachOrNull) {
			const rest = parseNode({...node, forEach: undefined, forEachOrNull: undefined}, false, false);
			const path = `${node.forEach || node.forEachOrNull}._nav(${rest})`;
			return !inUnion ? `_nav('e', ${path})` : path;
		}

		let output = [];
		if (node.column) {
			const columns = node.column.map( c => `_col('${c.name}', ${c.path||c.name})` );
			output.push(inUnion ? `_nav(${columns})` : columns);
		}

		if (node.select) {
			const path = node.select.map( n => parseNode(n, false, false) );
			output.push(isRoot || inUnion ? `_nav(${path.join(", ")})` : path);
		}

		if (node.unionAll) {
			const path = node.unionAll.map(n => parseNode(n, false, true));
			const unionPath = `_nav(${path.join(", ")})`;
			output.push(isRoot ? `_nav(${unionPath})` : unionPath);
		}

		return output.join(", ");
	}

	return parseNode(vd, true);
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