import fs from "fs";
import path from "path";
import {expect, test, describe} from "bun:test";
import duckdb from "duckdb";
import macros from "../templates/duck-macros";
import {templateToQuery} from "../src/query-builder.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

// Staged backend (SPEC_view_lowering): the first CTE reuses the existing source mechanism;
// the builder emits the rest of the query into {{fq_staged_tail}}.
export const stagedQueryTemplate = `
	{{fq_staged_macros}}
	{{fq_staged_with}} src AS {{fq_staged_src_materialized}}(
		SELECT {{fq_staged_src}}
		FROM read_json_auto(
			'{{test_file_path}}'
			{{fq_sql_input_schema}}
		)
		{{fq_where_filter}}
	){{fq_staged_tail}}
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
				// Per-test resources override the fixture default; each distinct resource set gets its
				// own scratch file so cases never read each other's data.
				const allResources = testCase.resources ?? testGroup.resources;
				// A view applies only to resources of its declared `resource` type; flatquack reads the
				// input with a type-coerced schema, so a foreign resourceType in the same file (e.g. an
				// Organization with a scalar `name` alongside Patients whose `name` is an array) breaks
				// the typed read. Feed only the matching type — the where-filter would drop the rest
				// anyway, so results are unchanged, and it mirrors the per-resource-type engine model.
				const viewType = testCase.view?.resource;
				const matching = viewType
					? allResources.filter(r => !r.resourceType || r.resourceType === viewType)
					: allResources;
				const resources = matching.length ? matching : allResources;
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
