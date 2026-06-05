## 1. Schema rule — truncate at a repeat seed (shared by both reads)

- [x] 1.1 In the path-walk feeding `pathsToSchema` (`src/ddb-sql-builder.js` /
  `src/view-parser.js`), add a "this field is a `repeat` seed → emit `JSON[]`, stop
  descending" rule, applied at arbitrary depth so the forced-JSON seed propagates up into a
  partial `STRUCT(item JSON[], …)` (design D3) — `parseVd` surfaces a `repeat` seed childless
  (→ `JSON[]`); `forceJson` in `pathsToSchema` wins over sibling navigation (shared field)
- [x] 1.2 Ensure `pathsToSchema` output is usable both as a `read_json` `columns=` schema and
  as a `from_json` structure string (`{"name":"TYPE"}` form), with `JSON[]` for truncated
  fields (design D3/D5) — `read_json` uses `pathsToSchema`; the `from_json` JSON form is the
  new `pathsToJsonStruct`, both off the same truncated path tree
- [x] 1.3 Probe-confirm in-repo that `from_json` NULL-fills missing fields, keeps `JSON[]`
  subfields raw, and tolerates unmapped keys (design D4); record the chosen function
  (`from_json` vs `json_transform`) — probed (DuckDB 1.5.2): `CAST` throws on absent keys;
  **`from_json`** NULL-fills, keeps declared `JSON[]` raw, drops unmapped keys → chosen

## 2. Classify `repeat` as a fan-out

- [x] 2.1 Remove `assertNoRepeat`; in `collectScope` classify a child with `repeat` as a
  fan-out (`{type: "repeat", node}`) instead of treating it as a transparent nested select
  (design D6)
- [x] 2.2 Confirm `subtreeHasFork` counts a `repeat` as a fan-out child so lone `repeat`
  ⇒ CHAIN and `repeat` among ≥2 siblings ⇒ FORK (design D6, spec "Repeat lowering") —
  `subtreeHasFork` now recurses into `repeat` subtrees too (sibling-repeats cases pass)
- [x] 2.3 Confirm `columnOrder` and the output projection contract still hold across a repeat
  scope (no key/`node` leakage) — keys/`node`/`el` stay internal; `columnOrder` unchanged

## 3. JSON descent (`WITH RECURSIVE`)

- [x] 3.1 Emit the descent fold for a listed path: single step → `UNNEST(fhir_list(node ->
  '$.p'))`; multi-step `a.b` → `list_transform(fhir_list(node -> '$.a'), x -> fhir_list(x ->
  '$.b')).flatten()`; multiple paths → `list_concat(…)` (design D1, spec "Repeat lowering") —
  `jsonFold` in `staged-sql-builder.js`
- [x] 3.2 Emit the recursive CTE: seed = listed paths off the enclosing node; recursive leg =
  same fold on each visited node; exclude the seed per `repeat` semantics (design D1) — seed
  is the typed `typedSeed` off the enclosing element, recursive leg is `jsonFold(node)`
- [x] 3.3 Make the assembled query lead with `WITH RECURSIVE` when the VD contains any
  `repeat` (`scripts/gen-staged.js` / staged assembly in `query-builder.js`); ensure exactly
  one lead keyword (design D7) — `{{fq_staged_with}}` = `WITH RECURSIVE`/`WITH`
- [x] 3.4 Make the `fhir_list` macro available to staged output (design D1) — added to
  `templates/duck-macros.js`
- [x] 3.5 Enforce the **simple-traversal-paths-only** limitation: accept dot-separated
  element-name paths; reject any listed `repeat` path using a function/filter/indexer
  (`where`/`ofType`/`first()`/`[n]`) with a clear error (proposal Non-goals, spec "Repeat
  lowering") — `assertSimplePath`

## 4. Per-repeat-scope typed bridge + binding mode

- [x] 4.1 Thread a binding mode (`typed` | `json`) through `emitScope`; `typed` scopes
  unchanged (design D2) — a repeat/json-each scope receives an `el` element (`bridgeElem`);
  `typed` scopes are byte-for-byte unchanged
- [x] 4.2 At a repeat scope, emit `from_json(node, '<structure>') AS el` with `<structure>`
  from the §1 schema rule over the scope's column/`forEach`/`where` paths; point the leaf
  engine's root-var at `el` and compile every column / arbitrary-FHIRPath `forEach` seed /
  `where` exactly as in a typed scope (design D5) — `emitRepeat` + `repeatStructure`
- [x] 4.3 Verify a `forEach` inside a repeat region re-establishes typed flow off the bridge
  struct, and a **nested** `repeat`'s seed arrives as `JSON[]` and re-enters `WITH RECURSIVE`
  (design D2/D3/D5) — `combined with forEach`, `repeat inside repeat`, triple-nesting all pass
- [x] 4.4 Verify choice-type leaves (`value.ofType(Coding)` → `el.valueCoding`) bind against
  the `from_json` structure (design "Risks": choice-type naming) — `tests/staged-repeat.test.js`
  binds `value.ofType(string)`/`value.ofType(integer)` off the bridge
- [x] 4.5 Factor each distinct `from_json` structure into a `CREATE OR REPLACE MACRO
  fq_cast_<name>(j) AS from_json(j, '<structure>')` emitted once in the preamble (beside
  `fhir_list`); keep a `structure → macro-name` map so identical structures (incl. a repeat's
  single canonical descent type) share one macro; call sites become `fq_cast_<name>(node)`
  (design D8) — `castMacroFor` + `{{fq_staged_macros}}` preamble
- [x] 4.6 Probe-confirm `from_json`-in-macro preserves return-type/field-access in-repo, and
  that macro names are collision-free within the emitted SQL (design D8) — probed: macro field
  access binds; names derive from `schemaPath` with an index fallback on collision

## 5. Chain and fork lowering for `repeat`

- [x] 5.1 Lone `repeat` (CHAIN): no key; carry the enclosing scope's typed scalars into and
  through the recursive CTE; continue `emitScope` on the repeat's child select in `json` mode
  (design D6; refs `basic`, `combined_with_forEach`, `repeat_inside_*`, triple-nesting)
- [x] 5.2 `repeat` as a FORK branch: carry the fork key, recombine `JOIN USING (key)` — root
  fork `rid`, nested fork `(rid, ord_i)` (design D6; refs `combined_with_unionAll` → `rid`,
  `sibling_repeats_inside_forEach` → `(rid, item_ord)`) — `sibling repeats at top level`
  (`rid`) and `sibling repeats inside forEach` (`(rid, ord1)`) pass
- [x] 5.3 `repeat` inside `unionAll`: union the keyed repeat branches with matching column
  names (ref `combined_with_unionAll`) — `prepUnion`/`emitUnion` handle a `repeat` branch
- [x] 5.4 Shared-field case (a `repeat` and a sibling `forEach` over the same field): the
  field is `JSON[]` at source, the `forEach` consumes it via the §4.2 bridge (ref
  `top-level_repeat_with_sibling_forEach`) — `forcedJsonPaths` + json-mode `emitJsonEach`

## 6. Spec delta + remove rejection

- [x] 6.1 Remove the `repeat` clause from "Unsupported directives" (delete the requirement if
  `repeat` was its only content) — REMOVED in the delta; `repeat` was its only content
- [x] 6.2 Apply the `staged-sql-emitter` spec delta in this change (Repeat lowering;
  Typed source CTE truncate-at-repeat-seed; lenient transform) — delta authored & valid
  (`openspec validate` passes); merge to the canonical spec happens at archive

## 7. Tests (do not modify the official reference JSON)

- [x] 7.1 Route the official `tests/spec-tests/repeat.json` suite through the `staged`
  backend in the staged runner (remove the prior exclusion) — `EXCLUDE` no longer matches
  `repeat`; rejection test removed
- [x] 7.2 Confirm every `repeat.json` case is multiset-identical to the `struct`-emitter
  oracle; fix the emitter (not the data) on any mismatch — cover basic, multi-path
  (`item and answer.item`), combined-with-`forEach`/`forEachOrNull`/`unionAll`,
  `repeat_inside_*`, sibling repeats (top-level and inside `forEach`), and triple-nesting —
  all 15 cases pass against the official `expect` data in both rootKey modes (the `struct`
  backend does not itself implement `repeat`; the baked-in `expect` values are the oracle)
- [x] 7.3 Add a case exercising an **arbitrary-FHIRPath** `forEach` inside a `repeat` (e.g.
  `value.ofType(...)` / `where(...)`) to lock in the typed-bridge behaviour —
  `tests/staged-repeat.test.js` (choice-type `value.ofType` off the bridge)
- [x] 7.4 Spot-check generated SQL against `tests/generated-sql/SPEC_hybrid/repeat.json/` for
  structural resemblance (JSON descent, `from_json` bridge, lazy keys); record intentional
  differences from the hand-written JSON-binding references (typed leaves via `from_json`) —
  `gen-staged.js` output verified: `WITH RECURSIVE` lead, `fhir_list` JSON descent,
  `fq_cast_*` from_json bridge, lazy keys. **Intentional difference:** leaves are typed via
  `from_json` (`el.linkId`) rather than raw JSON accessors (`node ->> '$.linkId'`), so
  arbitrary FHIRPath runs on the existing typed engine (the directory of hand-written
  JSON-binding references is not present in-repo)

## 8. Verification

- [x] 8.1 Run the full suite (`bun test`); staged `repeat` suite green, non-`repeat` staged
  suites and struct suites unchanged — staged suite green (incl. all `repeat` cases + the new
  typed-bridge test); the only failures are pre-existing `spec - repeat.json` on the `struct`
  backend (unchanged from baseline — `struct` has no recursion support and is out of scope)
- [x] 8.2 Confirm unbounded depth (no cap) on a deeply-nested fixture — 60-level
  `QuestionnaireResponse.item` chain returns all 60 descendants
- [x] 8.3 `openspec validate add-repeat-to-staged-emitter` passes
