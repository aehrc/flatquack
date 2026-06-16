import path from "path";
import {expect, test, describe, beforeAll, afterAll} from "bun:test";

import {templateToQuery} from "../src/query-builder.js";
import {stagedQueryTemplate, openMemoryDb, executeQuery} from "./test-util.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

// A ViewDefinition column name is a valid SQL identifier starting with a letter (validated in
// view-parser). The staged emitter carries internal bookkeeping columns (the resource key, fork
// ordinals, a repeat's descent path / node / pre-order index) alongside the user's columns in the
// same CTEs. If those internal names overlap a user column name, DuckDB sees a duplicate/ambiguous
// column — a hard binder error (or, inside a repeat's recursive CTE, a driver crash). Prefixing
// every internal identifier with `_` (which a valid column name can never start with) makes the
// collision impossible. These tests pin that: a view may legally name a column `rid`, `node`,
// `path`, or `ord` and still compile and return correct rows.

const verbose = process.env.VERBOSE === "1";

const patients = [
	{resourceType: "Patient", id: "p1", name: [{family: "Smith"}], telecom: [{system: "phone", value: "1"}]}
];
const questionnaires = [
	{
		resourceType: "QuestionnaireResponse", id: "qr1",
		item: [{linkId: "a", item: [{linkId: "a1"}]}]
	}
];

const patientFile = path.join(import.meta.dir, "./spec-tests/_reserved-names-patient.temp.json");
const qrFile = path.join(import.meta.dir, "./spec-tests/_reserved-names-qr.temp.json");

const build = (view, file, rootKey) => templateToQuery(
	view, fhirSchema, stagedQueryTemplate,
	[["test_file_path", file]], verbose, true, null, null, rootKey
);

let db;
beforeAll(async () => {
	await Bun.write(patientFile, JSON.stringify(patients));
	await Bun.write(qrFile, JSON.stringify(questionnaires));
	db = await openMemoryDb();
});
afterAll(async () => { await db.close(); });

describe("staged - user column names that collide with internal identifiers", () => {
	["natural", "uuid"].forEach(rootKey => {
		test(`a column named 'rid' under a root fork [${rootKey}]`, async () => {
			const view = {
				resource: "Patient",
				select: [
					{column: [{name: "rid", path: "id", type: "id"}]},
					{forEach: "name", column: [{name: "family", path: "family", type: "string"}]},
					{forEach: "telecom", column: [{name: "system", path: "system", type: "code"}]}
				]
			};
			const sql = build(view, patientFile, rootKey);
			if (verbose) console.log(sql);
			const result = await executeQuery(db, sql);
			expect(new Set(result)).toEqual(new Set([
				{rid: "p1", family: "Smith", system: "phone"}
			]));
		});

		test(`a column named 'node' carried into a %rowIndex repeat [${rootKey}]`, async () => {
			const view = {
				resource: "QuestionnaireResponse",
				select: [
					{column: [{name: "node", path: "id", type: "id"}]},
					{
						repeat: ["item"],
						column: [
							{name: "linkId", path: "linkId", type: "string"},
							{name: "idx", path: "%rowIndex", type: "integer"}
						]
					}
				]
			};
			const sql = build(view, qrFile, rootKey);
			if (verbose) console.log(sql);
			const result = await executeQuery(db, sql);
			expect(new Set(result)).toEqual(new Set([
				{node: "qr1", linkId: "a", idx: 0},
				{node: "qr1", linkId: "a1", idx: 1}
			]));
		});

		test(`columns named 'path' and 'ord' inside a %rowIndex repeat body [${rootKey}]`, async () => {
			const view = {
				resource: "QuestionnaireResponse",
				select: [
					{column: [{name: "id", path: "id", type: "id"}]},
					{
						repeat: ["item"],
						column: [
							{name: "path", path: "linkId", type: "string"},
							{name: "ord", path: "linkId", type: "string"},
							{name: "idx", path: "%rowIndex", type: "integer"}
						]
					}
				]
			};
			const sql = build(view, qrFile, rootKey);
			if (verbose) console.log(sql);
			const result = await executeQuery(db, sql);
			expect(new Set(result)).toEqual(new Set([
				{id: "qr1", path: "a", ord: "a", idx: 0},
				{id: "qr1", path: "a1", ord: "a1", idx: 1}
			]));
		});
	});
});
