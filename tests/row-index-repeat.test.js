import fs from "fs";
import path from "path";
import {expect, test, describe, beforeAll, afterAll} from "bun:test";

import {templateToQuery} from "../src/query-builder.js";
import {stagedQueryTemplate, openMemoryDb, executeQuery} from "./test-util.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

// Extended %rowIndex-over-repeat runner (Stage 4). The fixture `row_index_repeat.json` is marked
// `skip:true` so the generic auto-discovery spec suite ignores it (these cases go beyond the
// official SQL-on-FHIR tests); this dedicated runner reads the fixture directly and exercises the
// staged (hybrid) emitter — the sole emitter — in both root-key modes. Results are compared as Sets
// (order-independent), so each case is verified by the index value bound to each discriminator, not
// by output row order.

const verbose = process.env.VERBOSE === "1";

const fixturePath = path.join(import.meta.dir, "./spec-tests/row_index_repeat.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath));
const resourceFile = path.join(import.meta.dir, "./spec-tests/_row_index_repeat.temp.json");

const buildStaged = (view, rootKey) => templateToQuery(
	view, fhirSchema, stagedQueryTemplate,
	[["test_file_path", resourceFile]], verbose, true, null, null, rootKey
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
