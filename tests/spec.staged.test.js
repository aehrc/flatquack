import fs from "fs";
import path from "path";
import {expect, test, describe, beforeAll, afterAll} from "bun:test"
import {validateVd} from "../src/view-parser.js";

import {templateToQuery} from "../src/query-builder.js";
import {stagedQueryTemplate, openMemoryDb, getColumns, executeQuery} from "./test-util.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

const verbose = process.env.VERBOSE === "1";
const testDirectory = path.join(import.meta.dir, "./spec-tests/");

let db;

beforeAll(done => { db = openMemoryDb(); done(); });
afterAll(done => { db.close(() => done()); });

const files = fs.readdirSync(testDirectory);
let testFiles = [];

files.forEach( f => {
	if (/\.temp\.json|skip$|^\./.test(f)) return;
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
	[["test_file_path", resourceFile]], verbose, true, null, null, rootKey
);

describe("staged - column name validation", () => {
	test("duplicate column names across sibling scopes are rejected", () => {
		const view = {resource: "Patient", select: [
			{column: [{name: "x", path: "id", type: "id"}]},
			{forEach: "name", column: [{name: "x", path: "family", type: "string"}]}
		]};
		expect(() => validateVd(view)).toThrow(/duplicate column name/i);
	});

	test("duplicate column name between a column and a unionAll branch is rejected", () => {
		const view = {resource: "Patient", select: [
			{column: [{name: "v", path: "id", type: "id"}]},
			{unionAll: [
				{column: [{name: "v", path: "gender", type: "code"}]},
				{column: [{name: "v", path: "id", type: "id"}]}
			]}
		]};
		expect(() => validateVd(view)).toThrow(/duplicate column name/i);
	});

	test("matching names across unionAll branches (the required case) are allowed", () => {
		const view = {resource: "Patient", select: [
			{unionAll: [
				{column: [{name: "v", path: "gender", type: "code"}]},
				{column: [{name: "v", path: "id", type: "id"}]}
			]}
		]};
		expect(() => validateVd(view)).not.toThrow();
	});
});

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
