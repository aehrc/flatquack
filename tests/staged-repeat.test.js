import path from "path";
import {expect, test, describe, beforeAll, afterAll} from "bun:test";

import {templateToQuery} from "../src/query-builder.js";
import {stagedQueryTemplate, openMemoryDb, executeQuery} from "./test-util.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

// Locks in the typed-bridge behaviour (design D5, Risks/choice-type): a `forEach` *inside* a
// `repeat` region whose columns use arbitrary FHIRPath (`value.ofType(<type>)`) must re-establish
// typed evaluation off the from_json element — choice-type leaves (`value.ofType(string)` ->
// `el.valueString`, `value.ofType(integer)` -> `el.valueInteger`) must bind against the from_json
// structure. The official `repeat.json` suite never reads more than one choice type at once.

const verbose = process.env.VERBOSE === "1";

const resources = [
	{
		resourceType: "QuestionnaireResponse", id: "qr1",
		item: [
			{
				linkId: "1",
				item: [
					{
						linkId: "1.1",
						answer: [
							{valueString: "keep"},
							{valueString: "drop"},
							{valueInteger: 7}
						]
					}
				]
			}
		]
	}
];

const resourceFile = path.join(import.meta.dir, "./spec-tests/_staged-repeat.temp.json");

// `forEach` over a `where`-filtered answer collection, the column a choice-type leaf — both
// arbitrary FHIRPath evaluated typed against the from_json bridge inside the recursion.
const view = {
	resource: "QuestionnaireResponse",
	select: [
		{column: [{name: "id", path: "id", type: "id"}]},
		{
			repeat: ["item"],
			select: [
				{column: [{name: "linkId", path: "linkId", type: "string"}]},
				{
					forEach: "answer",
					column: [
						{name: "answerString", path: "value.ofType(string)", type: "string"},
						{name: "answerInteger", path: "value.ofType(integer)", type: "integer"}
					]
				}
			]
		}
	]
};

let db;
beforeAll(async () => {
	await Bun.write(resourceFile, JSON.stringify(resources));
	db = await openMemoryDb();
});
afterAll(async () => { await db.close(); });

describe("staged - repeat typed bridge (arbitrary FHIRPath)", () => {
	["natural", "uuid"].forEach(rootKey => {
		test(`choice-type ofType() forEach inside repeat [${rootKey}]`, async () => {
			const sql = templateToQuery(
				view, fhirSchema, stagedQueryTemplate,
				[["test_file_path", resourceFile]], verbose, true, null, null, rootKey
			);
			if (verbose) console.log(sql);
			const result = await executeQuery(db, sql);
			// Each answer binds the matching choice type; the other is NULL.
			expect(new Set(result)).toEqual(new Set([
				{id: "qr1", linkId: "1.1", answerString: "keep", answerInteger: null},
				{id: "qr1", linkId: "1.1", answerString: "drop", answerInteger: null},
				{id: "qr1", linkId: "1.1", answerString: null, answerInteger: 7}
			]));
		});
	});
});

// Regression for REPEAT_LAMBDA_COLLISION_BUG.md: a *column directly in a repeat scope* whose
// path navigates through an array (e.g. `answer.value.ofType(string)`) compiles to a
// `list_transform(el -> ...)`. The lambda parameter is hardcoded `el`, which collides with the
// repeat bridge element (also aliased `el`) — DuckDB binds `el.valueString` to the bridge struct
// (keys linkId/answer) instead of the lambda element, raising "Could not find key valuestring".
describe("staged - repeat scope array-navigating column (lambda collision)", () => {
	const collisionResources = [
		{
			resourceType: "QuestionnaireResponse", id: "qrc",
			item: [
				{linkId: "a", item: [{linkId: "a.1", answer: [{valueString: "x"}, {valueString: "y"}]}]}
			]
		}
	];
	const collisionFile = path.join(import.meta.dir, "./spec-tests/_staged-repeat-collision.temp.json");
	const collisionView = {
		resource: "QuestionnaireResponse",
		select: [
			{column: [{name: "id", path: "id", type: "id"}]},
			{
				repeat: ["item"],
				column: [
					{name: "linkId", path: "linkId", type: "string"},
					{name: "answers", path: "answer.value.ofType(string)", collection: true, type: "string"}
				]
			}
		]
	};
	const expected = [
		{id: "qrc", linkId: "a", answers: []},
		{id: "qrc", linkId: "a.1", answers: ["x", "y"]}
	];

	beforeAll(async () => { await Bun.write(collisionFile, JSON.stringify(collisionResources)); });

	["natural", "uuid"].forEach(rootKey => {
		test(`collection column navigating an array inside repeat [${rootKey}]`, async () => {
			const sql = templateToQuery(
				collisionView, fhirSchema, stagedQueryTemplate,
				[["test_file_path", collisionFile]], verbose, true, null, null, rootKey
			);
			if (verbose) console.log(sql);
			const result = await executeQuery(db, sql);
			expect(new Set(result.map(r => JSON.stringify(r)))).toEqual(
				new Set(expected.map(r => JSON.stringify(r))));
		});
	});
});
