import {expect, test, describe, beforeAll, afterAll} from "bun:test";
import {templateToQuery} from "../src/query-builder.js";
import {
	stagedQueryTemplate, testQueryTemplate, openMemoryDb, getColumns, executeQuery
} from "./test-util.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";

const verbose = process.env.VERBOSE === "1";

// Resources with unique, non-null ids (the SQL-on-FHIR norm): under that assumption the
// natural-key default and the struct oracle must agree exactly, and uuid mode (unique by
// construction) must too.
const RESOURCES = [
	{
		resourceType: "Patient", id: "p1",
		name: [
			{family: "Smith", given: ["Al", "Bo"], prefix: ["Mr"]},
			{family: "Jones", given: ["Cy"], prefix: ["Dr", "Sir"]}
		],
		telecom: [{system: "phone", value: "111"}, {system: "email", value: "a@b"}]
	},
	{
		resourceType: "Patient", id: "p2",
		name: [{family: "Doe", given: ["Dee"]}],
		telecom: []
	}
];

const RESOURCE_FILE = import.meta.dir + "/staged-rootkey.temp.json";

// Root-fork views: two+ sibling fan-outs at the resource scope (and a nested fork).
const VIEWS = {
	root_fork: {
		resource: "Patient",
		select: [
			{column: [{name: "id", path: "id", type: "id"}]},
			{forEach: "name", column: [{name: "family", path: "family", type: "string"}]},
			{forEach: "telecom", column: [{name: "system", path: "system", type: "code"}]}
		]
	},
	root_fork_or_null: {
		resource: "Patient",
		select: [
			{column: [{name: "id", path: "id", type: "id"}]},
			{forEach: "name", column: [{name: "family", path: "family", type: "string"}]},
			{forEachOrNull: "telecom", column: [{name: "system", path: "system", type: "code"}]}
		]
	},
	nested_fork: {
		resource: "Patient",
		select: [
			{column: [{name: "id", path: "id", type: "id"}]},
			{
				forEach: "name",
				select: [
					{forEach: "given", column: [{name: "given", path: "$this", type: "string"}]},
					{forEach: "prefix", column: [{name: "prefix", path: "$this", type: "string"}]}
				]
			}
		]
	},
	// 4.2a: a root fork that projects NO id column (two sibling forEach over non-id columns).
	// Natural mode must still read `id` to key the fork, without leaking it into the output.
	no_id_fork: {
		resource: "Patient",
		select: [
			{forEach: "name", column: [{name: "family", path: "family", type: "string"}]},
			{forEach: "telecom", column: [{name: "system", path: "system", type: "code"}]}
		]
	}
};

const buildStruct = (view) => templateToQuery(
	view, fhirSchema, testQueryTemplate,
	[["test_file_path", RESOURCE_FILE]], verbose, true, null, null, "struct"
);
const buildStaged = (view, rootKey) => templateToQuery(
	view, fhirSchema, stagedQueryTemplate,
	[["test_file_path", RESOURCE_FILE]], verbose, true, null, null, "staged", rootKey
);

let db;
beforeAll(async () => {
	await Bun.write(RESOURCE_FILE, JSON.stringify(RESOURCES));
	db = await openMemoryDb();
});
afterAll(async () => { await db.close(); });

// count rows of (a EXCEPT ALL b) — 0 means `a` has no row absent from `b` at its multiplicity.
async function exceptAllCount(a, b) {
	const rows = await executeQuery(db, `SELECT count(*) AS c FROM (\n(${a})\nEXCEPT ALL\n(${b})\n)`);
	return Number(rows[0].c);
}

describe("staged root-fork key modes are multiset-identical to the struct oracle", () => {
	Object.entries(VIEWS).forEach(([viewName, view]) => {
		["natural", "uuid"].forEach(rootKey => {
			test(`${viewName} [${rootKey}] EXCEPT ALL struct = 0 both directions`, async () => {
				const oracle = buildStruct(view);
				const staged = buildStaged(view, rootKey);
				if (verbose) { console.log(staged); }
				expect(await exceptAllCount(staged, oracle)).toBe(0);
				expect(await exceptAllCount(oracle, staged)).toBe(0);
			});
		});
	});
});

describe("4.2a: natural-key mode keys a fork on a view with no id column", () => {
	["natural", "uuid"].forEach(rootKey => {
		test(`no_id_fork [${rootKey}] reads id internally without leaking it`, async () => {
			const staged = buildStaged(VIEWS.no_id_fork, rootKey);
			const cols = await getColumns(db, staged);
			// The key (resource id / rid) is internal bookkeeping only.
			expect(cols).toEqual(["family", "system"]);
			const result = await executeQuery(db, staged);
			result.forEach(r => {
				expect(r).not.toHaveProperty("id");
				expect(r).not.toHaveProperty("rid");
			});
			// per-resource cross product: p1 has 2 names x 2 telecoms = 4 rows; p2 has empty telecom (INNER drops)
			expect(new Set(result)).toEqual(new Set([
				{family: "Smith", system: "phone"},
				{family: "Smith", system: "email"},
				{family: "Jones", system: "phone"},
				{family: "Jones", system: "email"}
			]));
		});
	});
});
