import fs from "fs";
import path from "path";
import {expect, test, describe, beforeAll, afterAll} from "bun:test";

import {templateToQuery} from "../src/query-builder.js";
import {testQueryTemplate, openMemoryDb, executeQuery} from "./test-util.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

let db;
let resourceFile;
let encounterFile;

const resource = {
	"resourceType": "QuestionnaireResponse",
	"item": [{
		"linkId": "crpValue",
		"definition": "crpValue",
		"text": "CRP value",
		"answer": [{"valueDecimal": 0.0006}]
	}]
};

// Encounter with a participant referencing a Practitioner — drives the issue #18
// test (a getReferenceKey() column inside a forEachOrNull).
const encounterResource = {
	resourceType: "Encounter",
	id: "enc1",
	status: "finished",
	participant: [{individual: {reference: "Practitioner/prac1"}}]
};

beforeAll(async () => {
	db = openMemoryDb();
	// Create temporary resource files
	resourceFile = path.join(import.meta.dir, "e2e-test-resources.temp.json");
	encounterFile = path.join(import.meta.dir, "e2e-encounter.temp.json");
	await Bun.write(resourceFile, JSON.stringify([resource]));
	await Bun.write(encounterFile, JSON.stringify([encounterResource]));
});

afterAll(done => {
	// Clean up temporary files
	for (const file of [resourceFile, encounterFile]) {
		if (file && fs.existsSync(file)) fs.unlinkSync(file);
	}
	db.close(() => done());
});

describe("e2e tests", () => {

	test("should not truncate decimal values", async () => {
		const viewDefinition = {
			"resource": "QuestionnaireResponse",
			"select": [{
				"column": [{
					"name": "crpValue",
					"path": "item.where(linkId='crpValue').answer.valueDecimal"
				}]
			}]
		};
		
		const expected = [{"crpValue": 0.0006}];
		const querySql = templateToQuery(
			viewDefinition, fhirSchema, 
			testQueryTemplate, [["test_file_path", resourceFile]], 
			true, true
		);

		const result = await executeQuery(db, querySql);
		expect(new Set(result)).toEqual(new Set(expected));
	});

	test("forEachOrNull with getReferenceKey() column binds on DuckDB 1.4.x (issue #18)", async () => {
		// getReferenceKey() lowers to a where() predicate whose _splitPath step uses the
		// lambda parameter as a method-call receiver (el.parse_path(...)). When that
		// predicate sits in a list_filter nested inside the forEachOrNull's
		// list_transform, DuckDB 1.4.x's binder fails to resolve the parameter:
		//   Binder Error: Referenced column "el" not found in FROM clause!
		// Emitting parse_path in function-call form binds correctly on 1.4.x and 1.5.x.
		const viewDefinition = {
			"resource": "Encounter",
			"select": [
				{"column": [{"name": "id", "path": "getResourceKey()"}]},
				{
					"forEachOrNull": "participant",
					"column": [{
						"name": "practitioner_id",
						"path": "individual.getReferenceKey(Practitioner)"
					}]
				}
			]
		};

		const expected = [{"id": "enc1", "practitioner_id": "prac1"}];
		const querySql = templateToQuery(
			viewDefinition, fhirSchema,
			testQueryTemplate, [["test_file_path", encounterFile]],
			true, true
		);

		const result = await executeQuery(db, querySql);
		expect(new Set(result)).toEqual(new Set(expected));
	});

	test("forEach with getReferenceKey() column binds on DuckDB 1.4.x (issue #18)", async () => {
		// Same nested-lambda codegen as the forEachOrNull case above; forEach only
		// differs by omitting the .ifnull2([NULL]) null-row suffix. Guards both
		// directives against regression of the parse_path binding fix.
		const viewDefinition = {
			"resource": "Encounter",
			"select": [
				{"column": [{"name": "id", "path": "getResourceKey()"}]},
				{
					"forEach": "participant",
					"column": [{
						"name": "practitioner_id",
						"path": "individual.getReferenceKey(Practitioner)"
					}]
				}
			]
		};

		const expected = [{"id": "enc1", "practitioner_id": "prac1"}];
		const querySql = templateToQuery(
			viewDefinition, fhirSchema,
			testQueryTemplate, [["test_file_path", encounterFile]],
			true, true
		);

		const result = await executeQuery(db, querySql);
		expect(new Set(result)).toEqual(new Set(expected));
	});
});
