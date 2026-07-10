import fs from "fs";
import path from "path";

import {buildStaged, scratchFile, openMemoryDb, getColumns, executeQuery, selectResources} from "../tests/test-util.js";

const outputPath = path.join(import.meta.dir, "../flatquack_test_output.json");
const testDirectory = path.join(import.meta.dir, "../tests/spec-tests/");

const testFiles = fs.readdirSync(testDirectory).filter(f => !(/\.temp\.json|skip$|^\./.test(f)));

// One shared in-memory db for the whole run: opening/closing a duckdb instance per test segfaults
// the native addon during teardown.
const db = openMemoryDb();

// Canonicalise a value so comparison ignores object-key order (DuckDB returns columns in query
// order, fixtures list them in authoring order) and BigInt/Number differences.
function canon(v) {
	if (typeof v === "bigint") return Number(v);
	if (Array.isArray(v)) return v.map(canon);
	if (v && typeof v === "object")
		return Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {});
	return v;
}
// Order-independent multiset comparison of result rows against the fixture's expectation.
const asMultiset = rows => JSON.stringify((rows ?? []).map(r => JSON.stringify(canon(r))).sort());
const sameRows = (a, b) => asMultiset(a) === asMultiset(b);
const sameColumns = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A case passes when it behaves as the fixture declares: an expectError case must throw; otherwise
// the result rows (and any expectColumns) must match.
async function runCase(testCase, resourceFile) {
	if (testCase.expectError) {
		try { await executeQuery(db, buildStaged(testCase.view, resourceFile)); return false; }
		catch { return true; }
	}
	try {
		const querySql = buildStaged(testCase.view, resourceFile);
		if (testCase.expect) {
			const result = await executeQuery(db, querySql);
			if (!sameRows(result, testCase.expect)) return false;
		}
		if (testCase.expectColumns) {
			const cols = await getColumns(db, querySql);
			if (!sameColumns(cols, testCase.expectColumns)) return false;
		}
		return true;
	} catch { return false; }
}

const output = {};
const stats = {passed: 0, failed: 0};

for (const file of testFiles) {
	const testGroup = JSON.parse(fs.readFileSync(testDirectory + file));

	const tests = [];
	for (const [i, testCase] of testGroup.tests.entries()) {
		// Mirror the harness: filter each case's resources to the view type (and honour a per-test
		// `resources` override) so the report never marks a harness-passing case as failing. Each case
		// gets its own scratch file since the selected set can differ per case.
		const resourceFile = scratchFile(`${file}.${i}.temp.json`);
		await Bun.write(resourceFile, JSON.stringify(selectResources(testCase, testGroup)));
		const passed = await runCase(testCase, resourceFile);
		stats[passed ? "passed" : "failed"]++;
		tests.push({name: testCase.title, result: {passed}});
	}
	output[file] = {tests};
}

console.log(stats);
await Bun.write(outputPath, JSON.stringify(output));
// NOTE: the duckdb native addon can segfault during process teardown on some Bun versions (seen on
// Bun 1.3.1). This fires only AFTER the output above is fully written, so the report is complete and
// correct regardless of the exit code.
process.exit(0);
