import fs from "fs";
import path from "path";
import {expect, test, describe, beforeAll, afterAll} from "bun:test";

import {templateToQuery} from "../src/query-builder.js";
import {stagedQueryTemplate, openMemoryDb, executeQuery} from "./test-util.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

// Staged-only runner for the extended %rowIndex-over-repeat cases (change
// add-rowindex-repeat-preorder). The fixture `row_index_repeat.json` is marked `skip:true` so the
// generic auto-discovery suites (spec.test.js / spec.staged.test.js) ignore it — those would also
// run it under the struct backend, which does not implement repeat pre-order. This runner reads the
// fixture directly and exercises only the staged template, in both root-key modes. Results are
// compared as Sets (order-independent), so each case is verified by the index value bound to each
// discriminator, not by output row order.

const verbose = process.env.VERBOSE === "1";

const fixturePath = path.join(import.meta.dir, "./spec-tests/row_index_repeat.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath));
const resourceFile = path.join(import.meta.dir, "./spec-tests/_row_index_repeat.temp.json");

const buildStaged = (view, rootKey) => templateToQuery(
	view, fhirSchema, stagedQueryTemplate,
	[["test_file_path", resourceFile]], verbose, true, null, null, "staged", rootKey
);

let db;
beforeAll(async () => {
	await Bun.write(resourceFile, JSON.stringify(fixture.resources));
	db = await openMemoryDb();
});
afterAll(async () => { await db.close(); });

describe("staged - " + fixture.title, () => {
	fixture.tests.forEach(testCase => {
		["natural", "uuid"].forEach(rootKey => {
			test(`${testCase.title} [${rootKey}]`, async () => {
				const sql = buildStaged(testCase.view, rootKey);
				if (verbose) console.log(sql);
				const result = await executeQuery(db, sql);
				expect(new Set(result.map(r => JSON.stringify(r))))
					.toEqual(new Set(testCase.expect.map(r => JSON.stringify(r))));
			});
		});
	});
});
