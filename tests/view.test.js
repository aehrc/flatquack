import {expect, test,  describe} from "bun:test";
import {parseVd} from "../src/view-parser.js";

describe("parse view definitions into superpath", () => {

	test("select inside of unionAll", () => {
		const view = {
			unionAll: [{
				select: [{column: [{name: "id"}]}]
			}]
		}
		const result = parseVd(view, true).path;
		const fp = `_forEach(
			_col_collection('u_1', 
				_unionAll(
					_forEach(
						_col('id', id)
					)
				)
			)
		)`;
		expect(result.replace(/\s*/g, "")).toEqual(fp.replace(/\s*/g,""));
	});

	test("multi-element select inside of unionAll", () => {
		const view = {
			unionAll: [{
				select: [{
					column: [{name: "id"}]
				},{
					column: [{name: "valueString"}]
				}]
			}]
		}
		const result = parseVd(view, true).path;
		const fp = `_forEach(
			_col_collection('u_1', 
				_unionAll(
					_forEach(
						_col('id', id),
						_col('valueString', valueString)
					)
				)
			)
		)`;
		expect(result.replace(/\s*/g, "")).toEqual(fp.replace(/\s*/g,""));
	});

	test("column and unionAll on same level", () => {
		const view = {
			select: [{
				column: [{name: "id"}]
			},{
				unionAll: [{
					column: [{name: "valueString"}]
				}]
			}]
		}
		const result = parseVd(view, true).path;
		const fp = `_forEach(
			_col('id', id),
			_col_collection('u_1', 
				_unionAll(
					_forEach(
						_col('valueString', valueString)
					)
				)
			)
		)`;
		expect(result.replace(/\s*/g, "")).toEqual(fp.replace(/\s*/g,""));
	});

	// An unknown select directive (e.g. `repeat`, which flatquack does not
	// implement) is silently ignored by default, producing a valid-but-wrong
	// query. Strict mode (3rd arg) makes validation reject it by name.
	const repeatView = {
		resource: "QuestionnaireResponse",
		select: [
			{ column: [{ path: "getResourceKey()", name: "id" }] },
			{ repeat: ["item"], column: [{ path: "linkId", name: "item_link_id" }] }
		]
	};

	test("strict mode rejects an unknown select directive", () => {
		expect(() => parseVd(repeatView, false, true).path).toThrow(/repeat/);
	});

	test("non-strict mode (default) ignores an unknown select directive", () => {
		expect(() => parseVd(repeatView).path).not.toThrow();
	});

	test("strict mode accepts a view using only known directives", () => {
		const validView = {
			resource: "Patient",
			select: [{ forEach: "name", column: [{ name: "family" }] }]
		};
		expect(() => parseVd(validView, false, true).path).not.toThrow();
	});

	// Strict validation is scoped to select-element directives: root-level
	// ViewDefinition keys (resource, name, where, ...) must not be rejected.
	test("strict mode does not reject root-level ViewDefinition keys", () => {
		const view = {
			resource: "Patient",
			name: "patient_names",
			where: [{ path: "active = true" }],
			select: [{ column: [{ name: "family", path: "name.family" }] }]
		};
		expect(() => parseVd(view, false, true).path).not.toThrow();
	});

	// The strict check must recurse into unionAll (and nested select) elements.
	test("strict mode rejects an unknown directive inside unionAll", () => {
		const view = {
			resource: "Patient",
			select: [{
				unionAll: [
					{ repeat: ["x"], column: [{ name: "family", path: "name.family" }] }
				]
			}]
		};
		expect(() => parseVd(view, false, true).path).toThrow(/repeat/);
	});

	test("validation should fail for select in union", () => {
		const view = {
			resource: "Observation",
			select: [{
				unionAll: [{
					select: [{
						forEach: "code.coding",
						column: [{name: "code"}]
					},{
						column: [{
							name: "value",
							path: "valueQuantity.value"
						}]
					}]
				}]
			}]
		};
		expect(() => {
			parseVd(view).path
		}).toThrow();
	});


});