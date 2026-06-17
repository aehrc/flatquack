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

// Strict-mode validation (fix/16): an unknown select directive is silently ignored by default,
// producing a valid-but-wrong query; strict mode (2nd arg) rejects it by name. Migrated from the
// retired view.test.js and adapted — `repeat` is now an IMPLEMENTED directive in this branch, so
// the "unknown directive" example uses `bogus`, and a dedicated test confirms `repeat` is accepted.
describe("view-parser - strict directive validation", () => {
	const bogusView = {
		resource: "QuestionnaireResponse",
		select: [
			{column: [{path: "getResourceKey()", name: "id"}]},
			{bogus: ["item"], column: [{path: "linkId", name: "item_link_id"}]}
		]
	};

	test("strict mode rejects an unknown select directive", () => {
		expect(() => validateVd(bogusView, true)).toThrow(/bogus/);
	});

	test("non-strict mode (default) ignores an unknown select directive", () => {
		expect(() => validateVd(bogusView)).not.toThrow();
	});

	test("strict mode accepts a view using only known directives", () => {
		const validView = {
			resource: "Patient",
			select: [{forEach: "name", column: [{name: "family"}]}]
		};
		expect(() => validateVd(validView, true)).not.toThrow();
	});

	test("strict mode accepts the implemented `repeat` directive", () => {
		const repeatView = {
			resource: "QuestionnaireResponse",
			select: [{repeat: ["item"], column: [{path: "linkId", name: "item_link_id"}]}]
		};
		expect(() => validateVd(repeatView, true)).not.toThrow();
	});

	// Strict validation is scoped to select-element directives: root-level ViewDefinition keys
	// (resource, name, where, ...) must not be rejected.
	test("strict mode does not reject root-level ViewDefinition keys", () => {
		const view = {
			resource: "Patient",
			name: "patient_names",
			where: [{path: "active = true"}],
			select: [{column: [{name: "family", path: "name.family"}]}]
		};
		expect(() => validateVd(view, true)).not.toThrow();
	});

	// The strict check must recurse into unionAll (and nested select) elements.
	test("strict mode rejects an unknown directive inside unionAll", () => {
		const view = {
			resource: "Patient",
			select: [{
				unionAll: [
					{bogus: ["x"], column: [{name: "family", path: "name.family"}]}
				]
			}]
		};
		expect(() => validateVd(view, true)).toThrow(/bogus/);
	});
});
