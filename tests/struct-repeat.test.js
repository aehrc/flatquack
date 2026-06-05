import fs from "fs";
import path from "path";
import {expect, test, describe, beforeAll, afterAll} from "bun:test";

import {templateToQuery} from "../src/query-builder.js";
import {testQueryTemplate, stagedQueryTemplate, openMemoryDb, executeQuery} from "./test-util.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

const verbose = process.env.VERBOSE === "1";
const specDir = path.join(import.meta.dir, "./spec-tests/");

const buildStruct = (view, rf, depth = 10) => templateToQuery(
	view, fhirSchema, testQueryTemplate, [["test_file_path", rf]], verbose, true, null, null, "struct", "natural", depth);
const buildStaged = (view, rf) => templateToQuery(
	view, fhirSchema, stagedQueryTemplate, [["test_file_path", rf]], verbose, true, null, null, "staged", "natural");

const key = r => JSON.stringify(r, Object.keys(r).sort());
const multiset = rows => new Set(rows.map(key));

let db;
beforeAll(async () => { db = await openMemoryDb(); });
afterAll(async () => { await db.close(); });

// 5.2 — every official `repeat.json` view yields multiset-identical rows on the struct backend
// and the staged backend (within the default depth) — a cross-check now that both implement it.
describe("struct - repeat.json struct/staged equivalence", () => {
	const group = JSON.parse(fs.readFileSync(path.join(specDir, "repeat.json")));
	const rf = path.join(specDir, "_struct-staged-equiv.temp.json");
	beforeAll(async () => { await Bun.write(rf, JSON.stringify(group.resources)); });

	group.tests.forEach(tc => {
		test(tc.title, async () => {
			const structRows = await executeQuery(db, buildStruct(tc.view, rf));
			const stagedRows = await executeQuery(db, buildStaged(tc.view, rf));
			expect(multiset(structRows)).toEqual(multiset(stagedRows));
			// And both match the baked oracle (sanity, in case the suite drifts).
			if (tc.expect) expect(multiset(structRows)).toEqual(multiset(tc.expect));
		});
	});
});

// 5.3 — arbitrary FHIRPath inside a `repeat` on the struct backend: a choice-type `value.ofType()`
// `forEach` (typed bridge binds the matching `valueX`), and a collection column navigating an
// array inside a repeat scope (the bridge var `rb` must not collide with the body lambda `__el`).
describe("struct - repeat arbitrary FHIRPath", () => {
	const resources = [{
		resourceType: "QuestionnaireResponse", id: "qr1",
		item: [{linkId: "1", item: [{linkId: "1.1", answer: [
			{valueString: "keep"}, {valueString: "drop"}, {valueInteger: 7}
		]}]}]
	}];
	const rf = path.join(specDir, "_struct-repeat-arb.temp.json");
	beforeAll(async () => { await Bun.write(rf, JSON.stringify(resources)); });

	test("choice-type ofType() forEach inside repeat", async () => {
		const view = {
			resource: "QuestionnaireResponse",
			select: [
				{column: [{name: "id", path: "id", type: "id"}]},
				{repeat: ["item"], select: [
					{column: [{name: "linkId", path: "linkId", type: "string"}]},
					{forEach: "answer", column: [
						{name: "answerString", path: "value.ofType(string)", type: "string"},
						{name: "answerInteger", path: "value.ofType(integer)", type: "integer"}
					]}
				]}
			]
		};
		const rows = await executeQuery(db, buildStruct(view, rf));
		expect(multiset(rows)).toEqual(multiset([
			{id: "qr1", linkId: "1.1", answerString: "keep", answerInteger: null},
			{id: "qr1", linkId: "1.1", answerString: "drop", answerInteger: null},
			{id: "qr1", linkId: "1.1", answerString: null, answerInteger: 7}
		]));
	});

	// Dedicated two-string-answer resource (mirrors tests/staged-repeat.test.js): the column
	// `answer.value.ofType(string)` compiles to a `list_transform(__el -> ...)` whose lambda var
	// must not collide with the repeat from_json bridge — the same bug class fixed for staged.
	const collisionResources = [{
		resourceType: "QuestionnaireResponse", id: "qrc",
		item: [{linkId: "a", item: [{linkId: "a.1", answer: [{valueString: "x"}, {valueString: "y"}]}]}]
	}];
	const collisionFile = path.join(specDir, "_struct-repeat-collision.temp.json");
	beforeAll(async () => { await Bun.write(collisionFile, JSON.stringify(collisionResources)); });

	test("collection column navigating an array inside repeat (lambda collision)", async () => {
		const view = {
			resource: "QuestionnaireResponse",
			select: [
				{column: [{name: "id", path: "id", type: "id"}]},
				{repeat: ["item"], column: [
					{name: "linkId", path: "linkId", type: "string"},
					{name: "answers", path: "answer.value.ofType(string)", collection: true, type: "string"}
				]}
			]
		};
		const rows = await executeQuery(db, buildStruct(view, collisionFile));
		expect(multiset(rows)).toEqual(multiset([
			{id: "qrc", linkId: "a", answers: []},
			{id: "qrc", linkId: "a.1", answers: ["x", "y"]}
		]));
	});
});

// 5.4 — bounded depth: full coverage at/below the configured depth, truncation beyond it,
// `--repeat-depth` (threaded as `repeatDepth`) raises the bound, and the emitted SQL size does
// not grow with the depth value (`list_resize` keeps it constant — only the literal differs).
describe("struct - repeat bounded depth", () => {
	// A single chain of `item`s nested `levels` deep: linkIds n0 (seed) .. n<levels>.
	const nest = levels => {
		let node = {linkId: `n${levels}`};
		for (let i = levels - 1; i >= 0; i--) node = {linkId: `n${i}`, item: [node]};
		return node;
	};
	const DEPTH_OF_DATA = 14;
	const resources = [{resourceType: "QuestionnaireResponse", id: "deep", item: [nest(DEPTH_OF_DATA)]}];
	const rf = path.join(specDir, "_struct-repeat-depth.temp.json");
	const view = {
		resource: "QuestionnaireResponse",
		select: [{repeat: ["item"], column: [{name: "linkId", path: "linkId", type: "string"}]}]
	};
	beforeAll(async () => { await Bun.write(rf, JSON.stringify(resources)); });

	test("default depth 10 covers seed + 10 descendant levels and truncates the rest", async () => {
		const rows = await executeQuery(db, buildStruct(view, rf, 10));
		// seed n0 + levels n1..n10 = 11 rows; n11..n14 are beyond the bound.
		expect(new Set(rows.map(r => r.linkId))).toEqual(new Set(
			Array.from({length: 11}, (_, i) => `n${i}`)));
	});

	test("raising the depth raises the bound (full coverage)", async () => {
		const rows = await executeQuery(db, buildStruct(view, rf, DEPTH_OF_DATA));
		expect(new Set(rows.map(r => r.linkId))).toEqual(new Set(
			Array.from({length: DEPTH_OF_DATA + 1}, (_, i) => `n${i}`)));
	});

	test("SQL size does not grow with the depth value", () => {
		const sqlSmall = buildStruct(view, rf, 10);
		const sqlHuge = buildStruct(view, rf, 100000);
		// The only difference is the baked `list_resize(..., <depth>+k)` literal; normalise it.
		const norm = s => s.replace(/list_resize\((.*?), \d+(\+\d+)\)/g, "list_resize($1, N$2)");
		expect(norm(sqlSmall)).toEqual(norm(sqlHuge));
	});
});
