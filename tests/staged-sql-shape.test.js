import {expect, test, describe} from "bun:test";
import {buildStaged} from "./test-util.js";

// SQL-shape assertion that cannot be expressed as a fixture (it inspects emitted SQL, not result
// rows). `%rowIndex` indexing a repeat's OWN descent scope is assigned by a pre-order window over
// the descent path (not a constant 0, not rejected). The end-to-end numbering is exercised by the
// row_index_repeat.json fixture; here we only assert the build compiles and emits the pre-order
// window. Internal carry/key/path columns are `_`-prefixed so they can never collide with a user
// column name: `_rid` partition, `_path` pre-order order.
describe("staged - %rowIndex over a repeat's own scope is a pre-order window", () => {
	const riView = {
		resource: "QuestionnaireResponse",
		select: [
			{column: [{name: "id", path: "id", type: "id"}]},
			{repeat: ["item"], column: [
				{name: "linkId", path: "linkId", type: "string"},
				{name: "ri", path: "%rowIndex", type: "integer"}
			]}
		]
	};
	test("emits a row_number() pre-order window partitioned per resource", () => {
		const sql = buildStaged(riView, "/tmp/unused.json", {rootKey: "natural"});
		expect(sql).toMatch(/row_number\(\) OVER \(PARTITION BY _rid ORDER BY _path\)/);
	});
});
