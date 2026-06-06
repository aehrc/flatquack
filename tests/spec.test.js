import fs from "fs";
import path from "path";
import {expect, test, describe, beforeAll, afterAll} from "bun:test"

import {templateToQuery} from "../src/query-builder.js";
import {testQueryTemplate, openMemoryDb, getColumns, executeQuery} from "./test-util.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

const verbose = true;
const testDirectory = path.join(import.meta.dir, "./spec-tests/");

let db;

beforeAll(async () => {
	db = await openMemoryDb();
});

afterAll(async () => {
	await db.close();
});


const files = fs.readdirSync(testDirectory)
let testFiles = [];

files.forEach( f => {
	if (/\.temp\.json|skip$|^\./.test(f)) return;
	const testGroup = JSON.parse(fs.readFileSync(path.join(testDirectory, f)))
	if (!testGroup.skip)
		testFiles.push({fileName: f, testGroup});
});

if (testFiles.find(f => f.testGroup.only))
	testFiles = testFiles.filter(f => f.testGroup.only);

testFiles.forEach( testFile => {
	const {fileName, testGroup} = testFile;
	const resourceFile = testDirectory + fileName + ".temp.json";
	Bun.write(resourceFile, JSON.stringify(testGroup.resources)); 
	describe("spec - " + fileName, () => {
		const onlyTests = testGroup.tests.filter( t => t.only );
		const tests = (onlyTests.length ? onlyTests : testGroup.tests);
		tests.forEach( testCase => {

			test( testCase.title, async () => {
				if (testCase.expectError) {
					return expect( async () => {
						const querySql = templateToQuery(
							testCase.view, fhirSchema, testQueryTemplate, 
							[["test_file_path", resourceFile]], verbose,
							true
						);
						if (verbose) console.log(querySql);
						//all tests will fail at compile time
						//except "fail when 'collection' is not true"
						//since it's not possible to know if a collection
						//will have than one item
						await executeQuery(db, querySql);
					}).toThrow();
				}
				const querySql = templateToQuery(
					testCase.view, fhirSchema, testQueryTemplate, 
					[["test_file_path", resourceFile]], verbose, true
				);

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
});