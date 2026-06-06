import {expect, test, beforeAll, afterAll, describe} from "bun:test";
import path from "path";

import {openMemoryDb} from "./test-util.js";

import {fhirpathToAst} from "../src/fhirpath-parser.js";
import {astToSql} from "../src/ddb-sql-builder.js"
import fhirSchema from "../schemas/fhir-schema-r4.json";

let db;

beforeAll(async () => {
	db = await openMemoryDb();
});

afterAll(async () => {
	await db.close();
});

async function testQuery(querySegment, resource, duckSchema) {
	console.log("DuckDB Query: ", querySegment)
	const filePath = path.join(import.meta.dirname, "./data.temp.json");
	Bun.write(filePath, JSON.stringify([resource]));
	const query = duckSchema
		? `SELECT ${querySegment} AS result FROM read_json('${filePath}', columns=${duckSchema})`
		: `SELECT ${querySegment} AS result FROM read_json_auto('${filePath}')`;
	const rows = await db.all(query);
	return rows[0].result;
}

function buildQuery(fp, resourceType, schema) {
	console.log("FHIRpath Expression: ", fp)
	const simplifiedFpAst = fhirpathToAst(fp,resourceType, schema);
	return astToSql(simplifiedFpAst).sql;
}

const numericObservation = {
	resourceType: "Observation",
	valueInteger: 12
}

const simplePatient = {
	resourceType: "Patient",
	birthDate: "2019-01-01",
	id: "123",
	name: [{family: "f1"}],
	link: [{
        other: {reference: "Patient/456"}
    }]
};

const nullContactName = {
	resourceType: "Patient",
	id: "123",
	contact: [{
		gender: "male",
		name: null
	}]	
}

const multipleNames = {
	resourceType: "Patient",
	id: "123",
	name: [{
		use: "official",
		family: "f1"
	},{ 
		use: "nickname",
		family: "f2", 
		given: ["g1", "g2"]
	}]
};

const deepNesting = {
	resourceType: "Patient",
	a: [{
		b: [{
			c: [{d: "e1"}]
		},{
			c: [{d: "e2"}] 	
		}]
	},{
		b: [{
			c: [{d: "e3"}]
		},{
			c: [{d: "e4"}] 	
		}]
	}]
}

const deepNestingSchema = {
	"Patient.a": {t: "x", a: true},
	"Patient.a.b": {t: "x", a: true},
	"Patient.a.b.c": {t: "x", a: true},
	"Patient.a.b.c.d": {t: "string", a: false}
}

describe("basic fhirpath to duckdb sql", () => {

	test("single field", async () => {
		const fp = "id";
		const resource = simplePatient;
		const target = "123";
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toBe(target);
	});

	test("nested field", async () => {
		const fp = "name.family";
		const resource = simplePatient;
		const target = ["f1"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("repeating field", async () => {
		const fp = "name.family";
		const resource = multipleNames;
		const target = ["f1", "f2"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("list filtering with equality", async () => {
		const fp = "name.where(use='nickname').family";
		const resource = multipleNames;
		const target = ["f2"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("list filtering with inequality", async () => {
		const fp = "name.where(use != 'nickname').family";
		const resource = multipleNames;
		const target = ["f1"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("list filtering with or", async () => {
		const fp = "name.where(use='nickname' or use='official').family";
		const resource = multipleNames;
		const target = ["f1", "f2"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("deep nesting", async () => {
		const fp = "a.b.c.d";
		const resource = deepNesting;
		const target = ["e1", "e2", "e3", "e4"];
		const query = buildQuery(fp, resource.resourceType, deepNestingSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("parenthesis", async () => {
		const fp = "((name).family)";
		const resource = multipleNames;
		const target = ["f1", "f2"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});


	test("join function", async () => {
		const fp = "a.b.c.d.join('|')";
		const resource = deepNesting;
		const target = "e1|e2|e3|e4";
		const query = buildQuery(fp, resource.resourceType, deepNestingSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("join function with no delimiter", async () => {
		const fp = "a.b.c.d.join('')";
		const resource = deepNesting;
		const target = "e1e2e3e4";
		const query = buildQuery(fp, resource.resourceType, deepNestingSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("first", async () => {
		const fp = "a.b.c.d.first()";
		const resource = deepNesting;
		const target = "e1";
		const query = buildQuery(fp, resource.resourceType, deepNestingSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("indexing", async () => {
		const fp = "name[1].given[0]";
		const resource = multipleNames;
		const target = "g1";
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("parenthesis with first", async () => {
		const fp = "((name).first().family)";
		const resource = multipleNames;
		const target = "f1";
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("filtering with $this in path", async () => {
		const fp = "name.where($this.use='nickname').family";
		const resource = multipleNames;
		const target = ["f2"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("filtering with a boolean", async () => {
		const fp = "id.where(true)";
		const resource = simplePatient;
		const target = "123";
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("exists on list with criteria", async () => {
		const fp = "name.exists(use='nickname')";
		const resource = multipleNames;
		const target = true;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("exists on list without criteria", async () => {
		const fp = "name.exists()";
		const resource = multipleNames;
		const target = true;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("exists on a non-list", async () => {
		const fp = "id.exists()";
		const resource = multipleNames;
		const target = true;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("empty on an empty list", async () => {
		const fp = "name.where(use='fake').empty()";
		const resource = multipleNames;
		const target = true;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("empty on a populated list", async () => {
		const fp = "name.where(use='nickname').empty()";
		const resource = multipleNames;
		const target = false;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("path starts with function", async () => {
		const fp = "where(name[0].family = 'f1')";
		const resource = simplePatient;
		const target = true;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("simple math", async () => {
		const fp = "1+1";
		const resource = simplePatient;
		const target = 2;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("math with parens", async () => {
		const fp = "(2+3)*2";
		const resource = simplePatient;
		const target = 10;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("math with element", async () => {
		const fp = "valueInteger * 2";
		const resource = numericObservation;
		const target = 24;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(Number(result)).toEqual(target);
	});

	test("fixed boolean value", async () => {
		const fp = "true";
		const resource = simplePatient;
		const target = true;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toBe(target);
	});

	test("initial exists function", async () => {
		const fp = "name.exists(family = 'f1')";
		const resource = simplePatient;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toBe(true);
	});

	test("path with a null scalar value", async () => {
		const fp = "contact.first().name.first().family";
		const resource = nullContactName;
		const target = null
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("flatten nested arrays", async () => {
		const fp = "name.given";
		const resource = multipleNames;
		const target = ["g1", "g2"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("getResourceKey function", async () => {
		const fp = "getResourceKey()";
		const resource = simplePatient;
		const target = "123";
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("getReferenceKey function without a parameter", async () => {
		const fp = "link.other.getReferenceKey()";
		const resource = simplePatient;
		const target = ["456"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("getReferenceKey function with a populated resource type", async () => {
		const fp = "link.other.getReferenceKey(Patient)";
		const resource = simplePatient;
		const target = ["456"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("getReferenceKey function with an unpopulated resource type", async () => {
		const fp = "link.other.getReferenceKey(Observation)";
		const resource = simplePatient;
		const target = [];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("inequality with dateTime literal", async () => {
		const fp = "birthDate > @2020-01-01";
		const resource = simplePatient;
		const target = false;
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});
});