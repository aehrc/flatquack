## Why

The SQL-on-FHIR `%rowIndex` environment variable is supported on the `struct` backend (change
`add-rowindex-struct`) but not on the `staged` (SPEC_hybrid) backend, so the `row_index.json`
reference suite is excluded from `spec.staged.test.js`. On staged, `%rowIndex` does not throw —
the shared FHIRPath front end already recognizes it as a contextual segment — but the staged leaf
compiler never passes a row-index expression to `astToSql`, so `%rowIndex` silently compiles to the
default `"0"` everywhere. This change brings the staged backend to parity with struct.

The staged emitter is structurally well-suited to `%rowIndex`: it realizes every `forEach` as
`UNNEST(…) WITH ORDINALITY`, which already yields a 1-based ordinal column. `%rowIndex` is simply
`(ord - 1)`. The plumbing is also already in place — `astToSql` accepts a `rowIndexSql` parameter
(added by `add-rowindex-struct`); the staged compiler just needs to supply it.

## What Changes

- Thread a current-row-index SQL expression through the staged emitter by adding `rowIndexSql` to
  the element descriptor (`rootElem` → `"0"`). `compilePath`/`compileColumn`/`arrayize` pass
  `elem.rowIndexSql || "0"` as `astToSql`'s row-index argument; the existing `rowIndex` segment then
  emits it.
- Make a `forEach`/`forEachOrNull` produce its `WITH ORDINALITY` ordinal when its scope uses
  `%rowIndex`, not only when its subtree forks. The ordinal joins the recombination `childKey`
  **only** for forks (existing behavior); the index-only case just needs it aliased in the stage's
  `FROM`. Bind `elem.rowIndexSql = (ord - 1)`.
- For `forEachOrNull` over an absent/empty collection, bind `%rowIndex` to `(coalesce(ord, 1) - 1)`
  so the synthesized null row (whose `LEFT JOIN … WITH ORDINALITY` ordinal is `NULL`) reports `0` —
  the staged analog of the struct backend's source-side null padding.
- Handle `%rowIndex` in `unionAll`: a `forEach` branch adds `WITH ORDINALITY` and binds `(ord - 1)`
  when its columns use `%rowIndex` (each branch numbers from `0` independently); a columns-only
  branch inherits the enclosing scope's `elem.rowIndexSql` (so `0` at the root, or the enclosing
  `forEach`'s index when nested) with no extra machinery.
- Detect `%rowIndex` usage by parsing each candidate path with `fhirpathToAst` and walking for the
  `rowIndex` segment (a `scopeUsesRowIndex` helper). Candidate paths are the columns compiled
  against the scope's element: the scope's direct/merged columns and any columns-only `unionAll`
  branch.
- Un-exclude `row_index.json` from `tests/spec.staged.test.js`.
- Scope: `staged` backend only, structural cases. `%rowIndex` over `repeat` (depth-first pre-order
  numbering) is a **known follow-up**, left failing exactly as the struct suite already carries it.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `staged-sql-emitter`: adds a requirement for `%rowIndex` support (contextual indexing across
  resource root, `forEach`, `forEachOrNull`, nested `forEach`, and both `unionAll` shapes), with the
  `repeat` pre-order sub-case explicitly out of scope.

## Impact

- `src/staged-sql-builder.js`: thread `rowIndexSql` on the element descriptor; widen the ordinal
  decision (exists when fork **or** scope uses `%rowIndex`; key only for forks); `coalesce` null-pad
  for `forEachOrNull`; ordinality + inherited index in `emitUnion`/`prepUnion`; add
  `scopeUsesRowIndex`.
- `tests/spec.staged.test.js`: remove the `row_index` exclusion.
- No public CLI/API surface changes. `astToSql`, the FHIRPath front end, and the struct backend are
  unchanged; the `repeat` follow-up is unaffected.
