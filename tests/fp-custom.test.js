import {expect, test, beforeAll, afterAll, describe} from "bun:test";
import path from "path";

import {openMemoryDb} from "./test-util.js";

import {fhirpathToAst} from "../src/fhirpath-parser.js";
import {astToSql} from "../src/ddb-sql-builder.js"
import fhirSchema from "../schemas/fhir-schema-r4.json";

let db;

beforeAll( done => {
	db = openMemoryDb();
	done();
});

afterAll( done => {
	db.close( () => done());
});

function testQuery(querySegment, resource, duckSchema) {
	console.log("DuckDB Query: ", querySegment)
	const filePath = path.join(import.meta.dirname, "./data.temp.json");
	Bun.write(filePath, JSON.stringify([resource]));
	const query = duckSchema
		? `SELECT ${querySegment} AS result FROM read_json('${filePath}', columns=${duckSchema})`
		: `SELECT ${querySegment} AS result FROM read_json_auto('${filePath}')`;
	return new Promise( (resolve, reject) => {
		db.all(query, (err, res) => {
			if (err) return reject(err);
			resolve(res[0].result);
		})
	})
}

function buildQuery(fp, resourceType, schema) {
	console.log("FHIRpath Expression: ", fp)
	const fpAst = fhirpathToAst(fp, resourceType, schema);
	return astToSql(fpAst).sql;
}

const simplePatient = {
	resourceType: "Patient",
	id: "id-123",
	name: [{family: "f1"}],
	link: [{
        other: {reference: "Patient/456"}
    }]
};

const simpleObservation = {
	resourceType: "Observation",
	id: "123",
	subject: {reference: "Patient/456"},
	code: {
		coding: [{
			system: 's1', code: 'c1'
		}]
	},
	valueString: "123"
};

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

describe("shared fhirpath leaf engine to duckdb sql", () => {

	test("_splitPath", async() => {
		const fp = "link.other.reference._splitPath(-1)";
		const resource = simplePatient;
		const target = ["456"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("function on nested structs", async() => {
		const fp = "subject.reference._splitPath(-1)";
		const resource = simpleObservation;
		const target = "456";
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

});

describe("_invoke function", () => {

	test("_invoke on scalar value", async () => {
		const fp = "id._invoke('upper')";
		const resource = simplePatient;
		const target = "ID-123";
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toBe(target);
	});

	test("_invoke on array value - maps over each element", async () => {
		const fp = "name.family._invoke('upper')";
		const resource = multipleNames;
		const target = ["F1", "F2"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("_invoke with string parameter", async () => {
		const fp = "id._invoke('concat', 'suffix')";
		const resource = simplePatient;
		const target = "id-123suffix";
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toBe(target);
	});

	test("_invoke with numeric parameters", async () => {
		const fp = "id._invoke('substring', 1, 2)";
		const resource = simplePatient;
		const target = "id";
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toBe(target);
	});

	test("_invoke with multiple parameters", async () => {
		const fp = "id._invoke('replace', '2', 'X')";
		const resource = simplePatient;
		const target = "id-1X3";
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toBe(target);
	});

	test("_invoke with parameters on array value", async () => {
		const fp = "name.family._invoke('concat', '_suffix')";
		const resource = multipleNames;
		const target = ["f1_suffix", "f2_suffix"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("_invoke should throw error when path is used in any parameter position", () => {
		const fp = "id._invoke('substring', name.family, 2)";
		const resource = simplePatient;
		expect(() => {
			buildQuery(fp, resource.resourceType, fhirSchema);
		}).toThrow(/_invoke parameter.*must be a scalar literal value/);
	});

	test("_invoke inside where() on scalar field", async () => {
		const fp = "name.where(family._invoke('upper') = 'F1')";
		const resource = multipleNames;
		const target = [{use: "official", family: "f1", given: null}];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("_invoke on array before where()", async () => {
		const fp = "name.family._invoke('upper').where($this = 'F1')";
		const resource = multipleNames;
		const target = ["F1"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

	test("_invoke on $this in where", async () => {
		const fp = "name.family.where($this._invoke('upper') = 'F1')";
		const resource = multipleNames;
		const target = ["f1"];
		const query = buildQuery(fp, resource.resourceType, fhirSchema);
		const result = await testQuery(query, resource);
		expect(result).toEqual(target);
	});

});
