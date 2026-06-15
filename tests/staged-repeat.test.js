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

// Regression for the FORK-inside-a-repeat-body bug: a repeat body that itself forks (>=2 fan-out
// children) over a resource with >1 descended node. The descent CTE keyed every node on `rid`
// only (constant per resource), so the fork branches recombined via `JOIN USING(rid)` and
// cross-produced across ALL nodes of the resource instead of per repeat node — wrong rows
// (e.g. item "a" paired with item "b"'s answers). The repeat must carry a per-node identity into
// the fork key. The official repeat.json suite misses this (its repeat+internal-fork cases all
// expect a single row, which cannot expose the cross-product).
describe("staged - fork inside a repeat body", () => {
	const forkResources = [
		{
			resourceType: "QuestionnaireResponse", id: "qrf",
			item: [
				{linkId: "a", answer: [{valueString: "a1"}, {valueString: "a2"}]},
				{linkId: "b", answer: [{valueString: "b1"}]}
			]
		}
	];
	const forkFile = path.join(import.meta.dir, "./_staged-repeat-fork.temp.json");
	const forkView = {
		resource: "QuestionnaireResponse",
		select: [
			{column: [{name: "id", path: "id", type: "id"}]},
			{
				repeat: ["item"],
				select: [
					{column: [{name: "linkId", path: "linkId", type: "string"}]},
					{forEach: "answer", column: [{name: "v1", path: "value.ofType(string)", type: "string"}]},
					{forEach: "answer", column: [{name: "v2", path: "value.ofType(string)", type: "string"}]}
				]
			}
		]
	};
	// Per node, the two forEach:answer siblings cross-product: item "a" (2 answers) -> 2x2 = 4,
	// item "b" (1 answer) -> 1x1 = 1, total 5 rows; v1/v2 always belong to the same item.
	const expected = [
		{id: "qrf", linkId: "a", v1: "a1", v2: "a1"},
		{id: "qrf", linkId: "a", v1: "a1", v2: "a2"},
		{id: "qrf", linkId: "a", v1: "a2", v2: "a1"},
		{id: "qrf", linkId: "a", v1: "a2", v2: "a2"},
		{id: "qrf", linkId: "b", v1: "b1", v2: "b1"}
	];

	beforeAll(async () => { await Bun.write(forkFile, JSON.stringify(forkResources)); });

	["natural", "uuid"].forEach(rootKey => {
		test(`two forEach siblings inside a repeat recombine per node [${rootKey}]`, async () => {
			const sql = templateToQuery(
				forkView, fhirSchema, stagedQueryTemplate,
				[["test_file_path", forkFile]], verbose, true, null, null, rootKey
			);
			if (verbose) console.log(sql);
			const result = await executeQuery(db, sql);
			expect(new Set(result.map(r => JSON.stringify(r)))).toEqual(
				new Set(expected.map(r => JSON.stringify(r))));
		});
	});
});

// `%rowIndex` indexing a repeat's OWN descent scope is Stage 4 (the recursive CTE has no
// per-iteration ordinal). It must be rejected at build time, not silently bound to a constant 0.
// `%rowIndex` for a forEach/forEachOrNull *inside* a repeat body is Stage 2 and keeps working
// (covered by the choice-type fixtures' iteration); this only guards the own-scope case.
describe("staged - %rowIndex over a repeat's own scope is rejected", () => {
	const riView = {
		resource: "QuestionnaireResponse",
		select: [
			{column: [{name: "id", path: "id", type: "id"}]},
			{repeat: ["item"], column: [
				{name: "linkId", path: "linkId", type: "string"},
				{name: "ri", path: "%rowIndex", type: "integer"}
			]}
		]
	};
	test("throws rather than emitting a constant", () => {
		expect(() => templateToQuery(
			riView, fhirSchema, stagedQueryTemplate,
			[["test_file_path", "/tmp/unused.json"]], verbose, true, null, null, "natural"
		)).toThrow(/%rowIndex/);
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
