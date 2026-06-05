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
		const fp = `_project(
			_col_collection('u_1',
				_unionAll(
					_project(
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
		const fp = `_project(
			_col_collection('u_1',
				_unionAll(
					_project(
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
		const fp = `_project(
			_col('id', id),
			_col_collection('u_1',
				_unionAll(
					_project(
						_col('valueString', valueString)
					)
				)
			)
		)`;
		expect(result.replace(/\s*/g, "")).toEqual(fp.replace(/\s*/g,""));
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