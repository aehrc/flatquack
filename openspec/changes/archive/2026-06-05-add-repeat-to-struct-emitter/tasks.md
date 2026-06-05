## 1. Extract shared repeat helpers (no behavior change)

- [x] 1.1 Create `src/repeat-lowering.js`; move `assertSimplePath`, `jsonFold`, `typedSeed`,
  `repeatStructure`, and `childElemOf` out of `src/staged-sql-builder.js`, parameterizing the
  schema/`vars`/builder dependencies (`compilePath`/`arrayize`) they currently close over (design D6)
- [x] 1.2 Update `src/staged-sql-builder.js` to import the helpers from the new module; delete the
  local copies
- [x] 1.3 Run the full `staged` suite (`tests/spec.staged.test.js`, `tests/staged-repeat.test.js`,
  `tests/staged-rootkey.test.js`) in both rootKey modes — all green, confirming the move is
  behavior-preserving

## 2. Parse `repeat` on the struct path

- [x] 2.1 In `src/view-parser.js` `parseVd`/`parseNode`, replace the non-root `_rseed` shim with a
  `_repeat` fan-out: register a flattening table (reuse the `each` table mechanism so `tablesToSql`
  cross-joins it) and walk the body so nested `forEach`/`select`/`unionAll` chain as child tables
  parented to the repeat table (design D1/D7)
- [x] 2.2 Validate `repeat` via `assertSimplePath` (reject `where`/`ofType`/`first()`/`[n]` with a
  clear error) and keep `validateVd` rules (mutually exclusive with `forEach`/`forEachOrNull`)
- [x] 2.3 Emit `_repeat` carrying the listed paths and the repeat element's resolved type so the
  body compiles re-rooted at the repeat element `schemaPath` (design D4)

## 3. Emit the reduce accumulator + typed bridge

- [x] 3.1 In `src/ddb-sql-builder.js`, add a `_repeat` case emitting the Phase-1 expression:
  `(list_reduce(list_resize([{acc: SEED, cur: SEED}], depth+1), step)).acc` with the
  empty-frontier no-op `CASE … ELSE st`; use field names `acc`/`cur` (never `all` — reserved word)
  (design D1/D2)
- [x] 3.2 Build `SEED` via the shared `typedSeed` and `EXPAND` via the shared `jsonFold`
  (`flatten(list_transform(cur, n -> <fold>))`, `list_concat` across multiple listed paths)
- [x] 3.3 Append the inline typed bridge `.list_transform(rb -> from_json(rb, '<structure>'))` with
  `<structure>` from the shared `repeatStructure`/`pathsToJsonStruct`; use a bridge lambda var (`rb`)
  distinct from the body lambda var (`L`/`__el`) to avoid shadowing (design D5, Risks)
- [x] 3.4 Compile the body as the existing `_forEach` body over the bridged typed list so columns
  and nested fan-outs reuse the two-phase machinery unchanged
- [x] 3.5 Confirm `tablesToSql` renders the repeat table as `CROSS JOIN UNNEST` and that body
  sub-fan-outs render as child `UNNEST`s via the `parent` chain

## 4. Schema, depth wiring, and assembly

- [x] 4.1 In `src/query-builder.js`, stop short-circuiting `struct` repeat views; force each repeat
  seed field to `JSON[]` in the read schema via `applyForcedJson` for the `struct` backend (collect
  the forced-JSON seed paths from the parsed view) (design D7)
- [x] 4.2 Thread a `repeatDepth` parameter through `buildQuery`/`templateToQuery` to the emitter
  (default 10); bake it into `list_resize(…, depth+1)` (design D3)
- [x] 4.3 Add `--repeat-depth` (default 10) to `src/cli.js` and pass it through
- [x] 4.4 Confirm the existing `fhir_list` macro (`templates/duck-macros.js`) is available on the
  `struct` templates; no `fq_cast_*` macro is added (bridge is inline, design D5)

## 5. Tests

- [x] 5.1 Confirm `tests/spec.test.js` (struct runner) now passes all 15 `repeat.json` cases
  against the baked `expect` oracle; fix the emitter (not the data) on any mismatch
- [x] 5.2 Add a struct↔staged equivalence check: every `repeat.json` view yields multiset-identical
  rows on both backends (within the default depth)
- [x] 5.3 Add an arbitrary-FHIRPath case mirroring `tests/staged-repeat.test.js` — a choice-type
  `value.ofType(...)` `forEach` inside a `repeat`, and a collection column navigating an array
  inside a `repeat` (lambda-collision guard)
- [x] 5.4 Add a deep-nesting fixture: assert full coverage at/below the configured depth and
  truncation beyond it; assert `--repeat-depth` raises the bound and the SQL length is unchanged

## 6. Spec + verification

- [x] 6.1 Run the full suite (`bun test`): struct `repeat.json` green, staged suites unchanged, no
  regressions in non-repeat struct/staged tests
- [x] 6.2 `openspec validate add-repeat-to-struct-emitter` passes
- [x] 6.3 Spot-check generated `struct` SQL for a basic and a nested-repeat view (reduce
  accumulator, `fhir_list` descent, inline `from_json` bridge, `CROSS JOIN UNNEST`); record any
  intentional differences from the staged references
