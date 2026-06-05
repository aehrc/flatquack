## Why

The `struct` emitter — the default backend and the **oracle** the `staged` emitter is verified
against — does not implement `repeat`. All 15 official `repeat.json` cases fail on `struct`
today: `parseVd` surfaces only the seed columns (`_col('_rseed', …)`) and never walks the body,
so a `repeat` view compiles to a broken partial query. `repeat` only works on `staged`, which
leaves the default backend non-conformant and removes the independent cross-check that made the
`staged` repeat work trustworthy.

`repeat` is the one unbounded-depth directive, which is why it could not sit on the typed
substrate as-is. The `staged` emitter solved the *evaluation* half of this (recurse in JSON,
evaluate every leaf typed via a `from_json` bridge); this change reuses that JSON-typed mix but
expresses the *recursion* in a form that fits the `struct` emitter's two-phase
(nested-struct → `CROSS JOIN UNNEST`) model.

## What Changes

- **Add `repeat` to the `struct` emitter.** A `repeat` lowers to a `result`-struct list field
  that is `CROSS JOIN UNNEST`ed by the existing flattener — i.e. `repeat` becomes a `forEach`
  whose iteration source is a recursive accumulation. The body (`column`/`forEach`/`select`/
  `unionAll`) is the existing two-phase machinery, unchanged.
- **Recursion via a bounded `list_reduce` accumulator** (not `WITH RECURSIVE`). An accumulator
  `{acc, cur}` is folded over a `list_resize`-padded driver list: each step appends the JSON
  descent of the current frontier (`acc`) and advances the frontier (`cur`); an empty frontier
  makes further steps a no-op. This composes inside a value expression, so nested/sibling
  repeats become nested/sibling list expressions and the struct emitter's natural Cartesian
  product replaces all of staged's fork-key/join machinery.
- **Same JSON-typed schema mix as `staged`.** The repeat seed is forced to `JSON[]` in the
  `read_json` `columns=` schema (existing `applyForcedJson` / truncate-at-repeat-seed rule); the
  descent navigates JSON via the `fhir_list` fold; each accumulated JSON node is bridged to a
  typed element with an inline `from_json(node, '<structure>')` (structure from
  `pathsToJsonStruct`), and every body leaf is compiled by the existing typed FHIRPath engine.
- **Configurable maximum depth, default 10.** Exposed as a CLI `--repeat-depth` option threaded
  through to the emitter. `list_resize` keeps the emitted SQL the same size at any depth.
  **BREAKING vs. spec-completeness:** unlike `staged`'s unbounded recursion, the `struct`
  recursion is **depth-bounded** — descendants deeper than the configured depth are silently
  omitted. The default (10) exceeds realistic `QuestionnaireResponse` nesting; `--repeat-depth`
  is the escape hatch.
- **Extract shared repeat helpers into a common module.** `assertSimplePath`, `jsonFold`,
  `typedSeed`, `repeatStructure`, and `childElemOf` move out of `staged-sql-builder.js` into a
  new shared module imported by both emitters (no behavior change to `staged`).
- Results SHALL be multiset-identical to the `repeat.json` oracle, and identical to the `staged`
  backend on that suite (a struct↔staged cross-check, now that both implement `repeat`).

## Capabilities

### New Capabilities
- `struct-sql-emitter`: the existing default (`struct`) SQL backend, specified here only for its
  new `repeat` lowering — JSON descent via a bounded `list_reduce` accumulator, per-node
  `from_json` typed bridge, configurable depth, and integration with the two-phase flattener.

### Modified Capabilities
<!-- none — staged-sql-emitter behavior is unchanged; the helper extraction is a pure refactor -->

## Impact

- **Code:**
  - New `src/repeat-lowering.js` (shared helpers extracted from `staged-sql-builder.js`).
  - `src/staged-sql-builder.js`: import the extracted helpers (no behavior change).
  - `src/view-parser.js`: `parseVd` walks a `repeat` body and emits a `_repeat` fan-out (plus a
    flattening table) on the `struct` path, instead of the seed-only `_rseed` placeholder.
  - `src/ddb-sql-builder.js`: emit the `list_reduce` accumulator + `from_json` bridge + body
    `list_transform` for `_repeat`; `tablesToSql` registers the repeat table like a `forEach`.
  - `src/query-builder.js`: stop routing `struct` repeat views to nothing; force the seed to
    `JSON[]` in the read schema; thread `repeatDepth` through `buildQuery`/`templateToQuery`.
  - `src/cli.js`: add `--repeat-depth` (default 10).
- **Behavior:** `repeat` views run on the default `struct` backend; bounded depth (default 10).
  Non-`repeat` views and the `staged` backend are unchanged.
- **Tests:** `tests/spec.test.js` (`struct` runner) now passes all `repeat.json` cases; add a
  deep-nesting fixture asserting truncation at the configured depth and full coverage below it;
  add a struct↔staged equivalence check on the `repeat.json` suite.
- **Dependencies:** none.
