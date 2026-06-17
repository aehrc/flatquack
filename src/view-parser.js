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

	// Column names must be unique across the whole view (SQL-on-FHIR §column.name). Without this, the
	// staged emitter would emit two same-named columns into a CTE; DuckDB silently keeps the first and
	// the other column's values are dropped with no error.
	const names = collectColumnNames(vd);
	const seen = new Set();
	const duplicate = names.find(n => seen.has(n) || (seen.add(n), false));
	if (duplicate)
		throw new Error(`duplicate column name '${duplicate}' - column names must be unique across a view`);
}

// Every column name a ViewDefinition projects, in document (tree) order: a transparent nested
// select contributes as part of its parent, and a unionAll contributes its (name-matched) branches
// once. This is the output projection contract — shared by validation (which detects duplicates)
// and the staged emitter's column ordering (which dedups).
export function collectColumnNames(node) {
	const names = [];
	(node.column || []).forEach(c => names.push(c.name));
	(node.select || []).forEach(child => names.push(...collectColumnNames(child)));
	if (node.unionAll) names.push(...collectColumnNames(node.unionAll[0]));
	return names;
}

// Build a single resource-rooted FHIRPath expression that nests every navigation a
// ViewDefinition performs (each forEach / forEachOrNull step wrapping its column paths, and
// unionAll branches). The staged emitter reads typed columns, so this expression — parsed by
// `fhirpathToAst` (which type-resolves child paths against their enclosing forEach element) and
// walked by `extractPathsFromAst` — supplies the read schema's path coverage. It is schema
// coverage only: no flattening tables / join machinery is produced.
//
// `_nav(...)` is an inert grouping wrapper: `extractPathsFromAst` recurses through any function's
// args regardless of name, so it serves only to carry the type context down each forEach step.
export function viewPaths(vd) {

	function parseNode(node) {
		// A `repeat` descends its listed paths recursively in JSON; the typed read schema needs
		// only the seed fields present (the staged emitter forces them to JSON[]), not the body —
		// the body re-enters typed via a from_json bridge. Surface the seed fields as nav leaves.
		if (node.repeat) {
			return `_nav(${node.repeat.join(", ")})`;
		}

		if (node.forEach || node.forEachOrNull) {
			const rest = parseNode({...node, forEach: undefined, forEachOrNull: undefined});
			return `${node.forEach || node.forEachOrNull}._nav(${rest})`;
		}

		const parts = [];
		if (node.column) parts.push(...node.column.map(c => c.path || c.name));
		if (node.select) parts.push(...node.select.map(parseNode));
		if (node.unionAll) parts.push(...node.unionAll.map(parseNode));
		return `_nav(${parts.join(", ")})`;
	}

	return parseNode(vd);
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

// Walk a path-tree (an `extractPathsFromAst` result: `{value, children}` nodes) along a
// dot-separated path. Returns the terminal node only when the FULL path resolves, else null — a
// partial match must not be treated as a hit (it points at a shallower ancestor).
export function navigatePathTree(tree, dotPath) {
	let level = tree, node = null;
	for (const seg of dotPath.split(".")) {
		node = level && level.find(n => n.value === seg);
		if (!node) return null;
		level = node.children;
	}
	return node;
}