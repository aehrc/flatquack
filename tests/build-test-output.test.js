import {expect, test, describe} from "bun:test";

import {selectResources} from "./test-util.js";

// Finding 4 (PR #34): the report generator must apply the SAME resource-selection the harness does,
// so a case that passes under `bun test` is never reported as failing. That logic (per-test
// `resources` override + view-type filter + non-empty fallback) is extracted into `selectResources`
// and shared by both. These unit tests pin its behaviour directly.
describe("selectResources", () => {
	const patient = {resourceType: "Patient", id: "p1"};
	const org = {resourceType: "Organization", id: "o1"};
	const patientView = {resource: "Patient", select: [{column: [{name: "id", path: "id"}]}]};

	test("filters a mixed input to the view's resource type", () => {
		// A Patient view over a mixed file yields only the Patients; the Organization is dropped.
		const testGroup = {resources: [patient, org], tests: []};
		const testCase = {view: patientView};
		expect(selectResources(testCase, testGroup)).toEqual([patient]);
	});

	test("is a no-op when every resource already matches the view type", () => {
		const testGroup = {resources: [patient], tests: []};
		const testCase = {view: patientView};
		expect(selectResources(testCase, testGroup)).toEqual([patient]);
	});

	test("a per-test resources override wins over the group resources", () => {
		// The per-test `resources` array replaces the group default before filtering.
		const override = [{resourceType: "Patient", id: "p2"}];
		const testGroup = {resources: [patient, org], tests: []};
		const testCase = {view: patientView, resources: override};
		expect(selectResources(testCase, testGroup)).toEqual(override);
	});

	test("keeps resources with no resourceType (they survive the type filter)", () => {
		// A bare resource with no resourceType is not foreign, so it is retained.
		const bare = {id: "x"};
		const testGroup = {resources: [bare, org], tests: []};
		const testCase = {view: patientView};
		expect(selectResources(testCase, testGroup)).toEqual([bare]);
	});

	test("falls back to all resources when the filter would empty the set", () => {
		// If nothing matches the view type, fall back to the full set rather than feed the query no rows.
		const testGroup = {resources: [org], tests: []};
		const testCase = {view: patientView};
		expect(selectResources(testCase, testGroup)).toEqual([org]);
	});

	test("returns all resources when the view declares no resource type", () => {
		const testGroup = {resources: [patient, org], tests: []};
		const testCase = {view: {select: []}};
		expect(selectResources(testCase, testGroup)).toEqual([patient, org]);
	});
});
