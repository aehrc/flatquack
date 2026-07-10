import {expect, test, describe} from "bun:test";
import {validateVd} from "../src/view-parser.js";

// Column-name validation (view-parser): names must be unique across sibling scopes that are
// combined into one row, but matching names ACROSS unionAll branches are required (the branches are
// the same output column). Moved out of the spec runner — these are unit tests on validateVd, not
// fixture data.
describe("view-parser - column name validation", () => {
	test("duplicate column names across sibling scopes are rejected", () => {
		const view = {resource: "Patient", select: [
			{column: [{name: "x", path: "id", type: "id"}]},
			{forEach: "name", column: [{name: "x", path: "family", type: "string"}]}
		]};
		expect(() => validateVd(view)).toThrow(/duplicate column name/i);
	});

	test("duplicate column name between a column and a unionAll branch is rejected", () => {
		const view = {resource: "Patient", select: [
			{column: [{name: "v", path: "id", type: "id"}]},
			{unionAll: [
				{column: [{name: "v", path: "gender", type: "code"}]},
				{column: [{name: "v", path: "id", type: "id"}]}
			]}
		]};
		expect(() => validateVd(view)).toThrow(/duplicate column name/i);
	});

	test("matching names across unionAll branches (the required case) are allowed", () => {
		const view = {resource: "Patient", select: [
			{unionAll: [
				{column: [{name: "v", path: "gender", type: "code"}]},
				{column: [{name: "v", path: "id", type: "id"}]}
			]}
		]};
		expect(() => validateVd(view)).not.toThrow();
	});
});
