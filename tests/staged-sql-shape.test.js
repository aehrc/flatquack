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

// On-demand typing (issue #35): cast-macro pooling and no-op invariants. These inspect emitted SQL
// (macro count / re-type wrapper presence), which fixtures cannot express. The from_json cast macro
// is `fq_cast_<schemaPath>`, pooled by structure string (so identical structures share one macro).
const countCastMacros = sql => (sql.match(/CREATE OR REPLACE MACRO fq_cast/g) || []).length;

describe("staged - on-demand typing: cast-macro pooling", () => {
	// A columns-only branch navigating item.linkId.first() and a repeat branch reading linkId both
	// need the SAME element structure {"linkId":"VARCHAR"}, so the macro pools to ONE definition.
	test("identical structures across a columns-only and a repeat branch share one macro", () => {
		const view = {resource: "Questionnaire", select: [{unionAll: [
			{column: [{name: "linkId", path: "item.linkId.first()", type: "string"}]},
			{repeat: ["item"], column: [{name: "linkId", path: "linkId", type: "string"}]}
		]}]};
		expect(countCastMacros(buildStaged(view, "/tmp/unused.json", {rootKey: "natural"}))).toBe(1);
	});
	// Two sibling repeats force two different element types (item, answer); their crossing columns
	// need different structures ({"linkId":...} vs {"valueString":...}), so two distinct macros.
	test("distinct forced element types get distinct macros", () => {
		const view = {resource: "QuestionnaireResponse", select: [{forEach: "item", select: [
			{column: [
				{name: "ic", path: "item.linkId.first()", type: "string"},
				{name: "ac", path: "answer.value.ofType(string).first()", type: "string"}
			]},
			{repeat: ["item"], column: [{name: "ri", path: "linkId", type: "string"}]},
			{repeat: ["answer"], column: [{name: "ra", path: "value.ofType(string)", type: "string"}]}
		]}]};
		expect(countCastMacros(buildStaged(view, "/tmp/unused.json", {rootKey: "natural"}))).toBe(2);
	});
	// Two columns navigating the SAME leaf of the forced field share the repeat's bridge structure
	// ({"linkId":"VARCHAR"}), so the whole view needs exactly one macro.
	test("two columns on the same leaf reuse a single macro", () => {
		const view = {resource: "Questionnaire", select: [
			{column: [
				{name: "a", path: "item.linkId.first()", type: "string"},
				{name: "b", path: "item[0].linkId", type: "string"}
			]},
			{repeat: ["item"], column: [{name: "rl", path: "linkId", type: "string"}]}
		]};
		expect(countCastMacros(buildStaged(view, "/tmp/unused.json", {rootKey: "natural"}))).toBe(1);
	});
	// Two columns navigating DIFFERENT leaves of one forced field merge into a single from_json
	// structure that carries both leaves (one cast per element, not one per leaf).
	test("two leaves of one forced field merge into one structure", () => {
		const view = {resource: "Questionnaire", select: [
			{column: [
				{name: "lk", path: "item.linkId.first()", type: "string"},
				{name: "mx", path: "item.maxLength.first()", type: "integer"}
			]},
			{repeat: ["item"], column: [{name: "rl", path: "linkId", type: "string"}]}
		]};
		const sql = buildStaged(view, "/tmp/unused.json", {rootKey: "natural"});
		expect(sql).toMatch(/from_json\(j, '\{"linkId":"VARCHAR","maxLength":"INTEGER"\}'\)/);
	});
	// Two ofType() choices on the same crossed polymorphic element (`value`) merge into ONE structure
	// carrying both typed leaves — the cast is per-element, not per-choice. (The end-to-end value of
	// each choice is governed by ofType/first semantics, which are exercised in the fixtures.)
	test("multiple ofType choices on one element merge into a single structure", () => {
		const view = {resource: "QuestionnaireResponse", select: [
			{column: [
				{name: "dec", path: "item.answer.value.ofType(decimal).first()", type: "decimal"},
				{name: "dt", path: "item.answer.value.ofType(date).first()", type: "date"}
			]},
			{repeat: ["item"], column: [{name: "rl", path: "linkId", type: "string"}]}
		]};
		const sql = buildStaged(view, "/tmp/unused.json", {rootKey: "natural"});
		expect(sql).toMatch(/\{"answer":\[\{"valueDecimal":"DOUBLE","valueDate":"VARCHAR"\}\]\}/);
	});
});

describe("staged - on-demand typing: no-op invariants", () => {
	// A view with no repeat forces nothing to JSON, so no cast macro and no re-type wrapper appear —
	// non-repeat compilation is unaffected by the feature.
	test("a non-repeat view emits no cast macro", () => {
		const view = {resource: "Questionnaire", select: [{column: [
			{name: "id", path: "id", type: "id"},
			{name: "fl", path: "item.linkId.first()", type: "string"}
		]}]};
		expect(buildStaged(view, "/tmp/unused.json", {rootKey: "natural"})).not.toMatch(/fq_cast/);
	});
	// Only the boundary-crossing column is wrapped in the from_json re-type; a plain column (`id`)
	// compiles untouched.
	test("only the boundary-crossing column is re-typed; a plain column is untouched", () => {
		const view = {resource: "Questionnaire", select: [
			{column: [
				{name: "id", path: "id", type: "id"},
				{name: "fl", path: "item.linkId.first()", type: "string"}
			]},
			{repeat: ["item"], column: [{name: "rl", path: "linkId", type: "string"}]}
		]};
		const sql = buildStaged(view, "/tmp/unused.json", {rootKey: "natural"});
		expect(sql).toMatch(/item\.list_transform\(x -> fq_cast_questionnaire_item\(x\)\)/);
		expect(sql).toMatch(/id AS id/);
	});
	// A repeat view whose columns never cross the boundary (only read the bridged element) emits no
	// inline re-type wrapper — the bridge alone types the body, nothing is double-cast.
	test("a repeat view with no boundary-crossing column emits no inline re-type wrapper", () => {
		const view = {resource: "Questionnaire", select: [
			{column: [{name: "id", path: "id", type: "id"}]},
			{repeat: ["item"], column: [{name: "rl", path: "linkId", type: "string"}]}
		]};
		const sql = buildStaged(view, "/tmp/unused.json", {rootKey: "natural"});
		expect(sql).not.toMatch(/list_transform\([A-Za-z_]+, x -> fq_cast/);
	});
});

// An operand of `+`/`-`/`*`/`and`/`or` (the `components` AST node) that navigates a repeat-forced
// field must receive the same inline re-type as a bare or compared navigation. This pins the fix for
// the components case, which previously dropped the re-type map: arithmetic then bound raw JSON and
// threw (`+(JSON, INTEGER)` has no overload — see ondemand_typing B11), while a boolean combinator
// was silently masked by DuckDB's implicit JSON->BOOLEAN coercion (B12). The behavioural fixtures
// can't catch the masked combinator case, so assert the cast on the emitted SQL here.
describe("staged - on-demand typing: components-operand boundary crossing", () => {
	const cast = /item\.list_transform\(x -> fq_cast_questionnaire_item\(x\)\)/;
	test("an arithmetic operand crossing the boundary is re-typed", () => {
		const view = {resource: "Questionnaire", select: [
			{column: [{name: "v", path: "item.maxLength.first() + 1", type: "integer"}]},
			{repeat: ["item"], column: [{name: "rl", path: "linkId", type: "string"}]}
		]};
		expect(buildStaged(view, "/tmp/unused.json", {rootKey: "natural"})).toMatch(cast);
	});
	test("a boolean-combinator operand crossing the boundary is re-typed", () => {
		const view = {resource: "Questionnaire", select: [
			{column: [{name: "v", path: "item.required.first() or false", type: "boolean"}]},
			{repeat: ["item"], column: [{name: "rl", path: "linkId", type: "string"}]}
		]};
		expect(buildStaged(view, "/tmp/unused.json", {rootKey: "natural"})).toMatch(cast);
	});
});
