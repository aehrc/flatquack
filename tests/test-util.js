import fs from "fs";
import path from "path";
import {expect, test, describe} from "bun:test";
import duckdb from "duckdb";
import macros from "../templates/duck-macros";
import {templateToQuery} from "../src/query-builder.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

// Staged backend (SPEC_sql_template_contract): the template binds the input relation as `_fq_input`
// (resource columns), the emitter's sealed pipeline flattens it and produces `_fq_output`, and the
// template projects that as the final SELECT. Base macros are loaded into the db in openMemoryDb,
// so only the per-view cast macros ({{fq_sql_view_macros}}) appear here.
export const stagedQueryTemplate = `
	{{fq_sql_view_macros}}
	{{fq_sql_with}} {{fq_sql_input}} AS (
		SELECT * FROM read_json_auto(
			'{{test_file_path}}'
			{{fq_sql_input_schema}}
		)
		{{fq_sql_where}}
	),
	{{fq_sql_pipeline}}
	SELECT {{fq_sql_output_columns}} FROM {{fq_sql_output}}
`

export function openMemoryDb() {
	const db = new duckdb.Database(':memory:');
	db.all(macros);
	return db;
}

export function getColumns(db, query) {
	return new Promise( (resolve, reject) => {
		db.prepare(query, (err, stmt) => {
			if (err) return reject(err);
			resolve(stmt.columns().map(c => c.name));
		})
	});
}

export function executeQuery(db, query) {
	return new Promise( (resolve, reject) => {
		db.all(query, (err, res) => {
			if (err) return reject(err);
			resolve(res);
		})
	});
}

// Compile a ViewDefinition through the staged (hybrid) emitter — the single shared entry point for
// every staged test. `resourceFile` is the on-disk JSON the generated SQL reads via read_json_auto.
export function buildStaged(view, resourceFile, {rootKey = "natural", verbose = false} = {}) {
	return templateToQuery(
		view, fhirSchema, stagedQueryTemplate,
		[["test_file_path", resourceFile]], verbose, true, null, null, rootKey
	);
}

// Scratch directory for the generated resource files. Kept out of the fixture directories so
// `spec-tests/` and `custom-tests/` stay clean; covered by the `*.temp.json` .gitignore rule.
const SCRATCH_DIR = path.join(import.meta.dir, ".tmp");

export function scratchFile(name) {
	fs.mkdirSync(SCRATCH_DIR, {recursive: true});
	return path.join(SCRATCH_DIR, name);
}

// The resource set a case runs against. A per-test `resources` array overrides the group default;
// then the view applies only to resources of its declared `resource` type — flatquack reads the input
// with a type-coerced schema, so a foreign resourceType in the same file (e.g. an Organization with a
// scalar `name` alongside Patients whose `name` is an array) breaks the typed read. Feed only the
// matching type (the where-filter would drop the rest anyway, so results are unchanged, mirroring the
// per-resource-type engine model), falling back to the full set if the filter would empty it. Shared
// by the harness (runFixtureSuite) and the conformance report generator so both select identically.
export function selectResources(testCase, testGroup) {
	const allResources = testCase.resources ?? testGroup.resources;
	const viewType = testCase.view?.resource;
	const matching = viewType
		? allResources.filter(r => !r.resourceType || r.resourceType === viewType)
		: allResources;
	return matching.length ? matching : allResources;
}

// Shared JSON-fixture-suite runner. Discovers every `*.json` fixture in `dir`, then registers one
// test per (case x root-key mode). Used by both the official runner (spec-tests/) and the custom
// runner (custom-tests/). Honours the official conventions — the file filter, the file-level `skip`
// flag, file- and test-level `only`, `expectError`, `expect` (order-independent Set comparison) and
// `expectColumns` — plus a custom extension: a per-test `resources` array overriding the fixture's
// top-level `resources` (lets one custom fixture hold cases with differing input data).
export function runFixtureSuite({dir, db, rootKeyModes = ["natural", "uuid"]}) {
	const verbose = process.env.VERBOSE === "1";
	const testDirectory = path.join(import.meta.dir, dir);
	// The db is opened in beforeAll, so resolve it lazily when each test body runs.
	const getDb = typeof db === "function" ? db : () => db;

	let testFiles = [];
	fs.readdirSync(testDirectory).forEach( f => {
		if (/\.temp\.json|skip$|^\./.test(f)) return;
		const testGroup = JSON.parse(fs.readFileSync(path.join(testDirectory, f)));
		if (!testGroup.skip)
			testFiles.push({fileName: f, testGroup});
	});

	if (testFiles.find(f => f.testGroup.only))
		testFiles = testFiles.filter(f => f.testGroup.only);

	testFiles.forEach( ({fileName, testGroup}) => {
		describe("staged - " + fileName, () => {
			const onlyTests = testGroup.tests.filter( t => t.only );
			const tests = (onlyTests.length ? onlyTests : testGroup.tests);
			tests.forEach( (testCase, i) => {
				// Per-test resources override the fixture default and are filtered to the view type; each
				// distinct resource set gets its own scratch file so cases never read each other's data.
				const resources = selectResources(testCase, testGroup);
				const resourceFile = scratchFile(`${fileName}.${i}.temp.json`);
				rootKeyModes.forEach( rootKey => {
					test( `${testCase.title} [${rootKey}]`, async () => {
						await Bun.write(resourceFile, JSON.stringify(resources));
						if (testCase.expectError) {
							return expect( async () => {
								const querySql = buildStaged(testCase.view, resourceFile, {rootKey, verbose});
								if (verbose) console.log(querySql);
								await executeQuery(getDb(), querySql);
							}).toThrow();
						}
						const querySql = buildStaged(testCase.view, resourceFile, {rootKey, verbose});
						if (verbose) console.log(querySql);
						const result = await executeQuery(getDb(), querySql);
						if (testCase.expect)
							expect(new Set(result)).toEqual(new Set(testCase.expect));
						if (testCase.expectColumns) {
							const cols = await getColumns(getDb(), querySql);
							expect(cols).toEqual(testCase.expectColumns);
						}
					});
				});
			});
		});
	});
}
