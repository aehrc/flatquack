import fs from "fs";
import path from "path";
import {expect, test, describe, beforeAll, afterAll} from "bun:test"

import {templateToQuery} from "../src/query-builder.js";
import {stagedQueryTemplate, openMemoryDb, getColumns, executeQuery} from "./test-util.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

const verbose = process.env.VERBOSE === "1";
const testDirectory = path.join(import.meta.dir, "./spec-tests/");

// `%rowIndex` is fully implemented on the staged backend, including the `repeat` sub-test, whose
// SQL-on-FHIR depth-first pre-order numbering is realized via a materialized integer descent path
// and a path-ordered window (change `add-rowindex-repeat-preorder`). Extended repeat cases not
// covered by the official `row_index.json` live in `row_index_repeat.json` (staged-only, run by
// `tests/row-index-repeat.test.js`).
const EXCLUDE = null;

let db;

beforeAll(async () => { db = await openMemoryDb(); });
afterAll(async () => { await db.close(); });

const files = fs.readdirSync(testDirectory);
let testFiles = [];

files.forEach( f => {
	if (/\.temp\.json|skip$|^\./.test(f)) return;
	if (EXCLUDE && EXCLUDE.test(f)) return;
	const testGroup = JSON.parse(fs.readFileSync(path.join(testDirectory, f)))
	if (!testGroup.skip)
		testFiles.push({fileName: f, testGroup});
});

if (testFiles.find(f => f.testGroup.only))
	testFiles = testFiles.filter(f => f.testGroup.only);

// Both root-fork key modes must produce identical results on every reference view.
const ROOT_KEY_MODES = ["natural", "uuid"];

const buildStaged = (view, resourceFile, rootKey="natural") => templateToQuery(
	view, fhirSchema, stagedQueryTemplate,
	[["test_file_path", resourceFile]], verbose, true, null, null, "staged", rootKey
);

testFiles.forEach( testFile => {
	const {fileName, testGroup} = testFile;
	const resourceFile = testDirectory + fileName + ".temp.json";
	Bun.write(resourceFile, JSON.stringify(testGroup.resources));
	describe("staged - " + fileName, () => {
		const onlyTests = testGroup.tests.filter( t => t.only );
		const tests = (onlyTests.length ? onlyTests : testGroup.tests);
		tests.forEach( testCase => {
			ROOT_KEY_MODES.forEach( rootKey => {

			test( `${testCase.title} [${rootKey}]`, async () => {
				if (testCase.expectError) {
					return expect( async () => {
						const querySql = buildStaged(testCase.view, resourceFile, rootKey);
						if (verbose) console.log(querySql);
						await executeQuery(db, querySql);
					}).toThrow();
				}
				const querySql = buildStaged(testCase.view, resourceFile, rootKey);
				if (verbose) console.log(querySql)
				const result = await executeQuery(db, querySql);
				if (testCase.expect)
					expect(new Set(result)).toEqual(new Set(testCase.expect));
				if (testCase.expectColumns) {
					const cols = await getColumns(db, querySql);
					expect(cols).toEqual(testCase.expectColumns);
				}
			});
			})
		})
	})
});
