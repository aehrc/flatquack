## Context

`%rowIndex` is a SQL-on-FHIR environment variable giving the 0-based position of the current
element within its enclosing iteration. The reference suite is `tests/spec-tests/row_index.json`.

Today the `struct` backend cannot compile any view that uses it. The FHIRPath front end
(`src/fhirpath-parser.js`) routes every `%`-constant through `ExternalConstant → vars[name]` and
throws `Variable %rowIndex is not defined` when it is absent. `%rowIndex` is contextual, not a
`--var`, so it needs its own path.

The `struct` emitter (`src/ddb-sql-builder.js`) builds each output row **inside** a
`list_transform` and then flattens the resulting list with `UNNEST` (`tablesToSql`). A `forEach`
over `name` compiles to `name.list_transform(__el -> {…cols…})`, later `CROSS JOIN UNNEST`ed.
DuckDB's `list_transform` accepts an optional **1-based index** lambda parameter
(`list_transform(lst, (x, i) -> …)`, verified working), which is the natural carrier for the
position — it is computed pre-`UNNEST` and rides through flattening as an ordinary struct field.

Two structural facts complicate a naive "use the lambda index" approach:

1. `src/view-parser.js` emits the **same** `_forEach` directive for two different things:
   projection wrappers (resource root, `select`, and `unionAll` branches — none of which iterate)
   and real iteration (`field._forEach(…)`). The middle emit branch
   (`as_list().list_transform(__el -> …)`, used when the input is a single non-array element) is
   reached by both a real scalar `forEach` and a non-iterating `unionAll` branch.
2. `forEachOrNull` over an absent/empty collection currently appends `.ifnull2([NULL])` **after**
   the transform, so the synthesized null row never passes through the lambda and would carry no
   index.

## Goals / Non-Goals

**Goals:**
- Compile and correctly evaluate `%rowIndex` on the `struct` backend for: resource root, `forEach`,
  `forEachOrNull` (including the empty/null row), nested `forEach`, `unionAll` (independent
  per-branch sequences), and `unionAll` branches without their own `forEach` (inherit enclosing
  index).
- Recognize `%rowIndex` as contextual without disturbing existing `--var` resolution.
- Keep the change localized to the FHIRPath front end, the struct emitter, and the view parser.

**Non-Goals:**
- Depth-first pre-order numbering for `%rowIndex` over `repeat`. The struct `repeat` lowering
  accumulates breadth-first (verified: `1, 2, 1.1, 1.2`); the reference expects pre-order
  (`1, 1.1, 1.2, 2`). `%rowIndex` over `repeat` is emitted over the existing BFS order, and the
  `row_index.json` `repeat` sub-test is left failing as a known follow-up.
- Staged (`SPEC_hybrid`) backend support. `row_index.json` is excluded from `spec.staged.test.js`
  via its existing `EXCLUDE` mechanism.
- `%rowIndex` inside `where` predicates (not exercised by the suite; no defined behavior added).

## Decisions

### D1: Parse `%rowIndex` as a dedicated contextual segment

In `simplifyFhirPath`'s `ExternalConstant` case, special-case the name `rowIndex` **before** the
`vars` lookup and return a new segment `{ segmentType: "rowIndex", type: { fhirType: "integer",
isArray: false } }`. All other constants keep the existing `vars[name]` path and the existing
"not defined" error.

*Alternative considered:* pre-seed `vars.rowIndex`. Rejected — its value is contextual (varies per
iteration scope and per row), not a single literal, so it cannot be a `vars` entry.

### D2: Thread a current-row-index SQL expression through the emitter

`astToSql` gains a parameter carrying the SQL for "the current `%rowIndex`" (default `"0"`). The
`rowIndex` segment emits exactly that string. The parameter is threaded alongside the existing
`rootVar`, so every recursive call that rebinds the lambda element also carries the matching index.

*Alternative considered:* resolve `%rowIndex` post-`UNNEST` using `UNNEST … WITH ORDINALITY` at the
flattening layer (as the staged backend already does for fork keys). Rejected for this change: the
ordinal of a `unionAll` UNNEST is not the semantic `%rowIndex` (test "unionAll without forEach"
expects `0`, not the branch ordinal), and `%rowIndex` can appear anywhere inside a column
expression, so deferring it out of the pre-`UNNEST` value expression is more invasive. The
in-lambda index keeps `%rowIndex` a normal sub-expression.

### D3: Open a new index scope only for real iteration; pass through for projection

A real iteration `_forEach`/`_forEachOrNull`/`_repeat` over a collection emits an **indexed**
lambda `(__el, __idxN) -> {…}` and binds the threaded index to `(__idxN - 1)` for its body. A
**projection** wrapper does not open a scope and passes the enclosing index through unchanged
(`0` at the root; the enclosing `forEach`'s index for a nested `unionAll` branch).

The two are disambiguated by whether the `_forEach` directive is preceded by navigation: real
iteration is always `field._forEach(…)` (≥1 preceding nav segment in its expression array);
projection wrappers are a bare `_forEach(…)` at the head of their array (resource root, `select`,
`unionAll` branch). The emitter already routes these through different branches by input type
(`!inputType.fhirType` = root projection; array input = real iteration). The remaining ambiguous
branch is the single-element `as_list().list_transform(…)` case, which a bare-vs-prefixed signal
resolves: a bare projection branch inherits the index; a real scalar `forEach` opens a scope whose
single element is index `0`.

*Implementation note:* the cleanest expression of this signal is a distinct directive (e.g.
`_project`) emitted by `view-parser.js` for the root/select/unionAll column wrappers, leaving
`_forEach`/`_forEachOrNull` to mean real iteration only. The equivalent "is this the first element
of its expression array?" check inside `astToSql` is acceptable if it proves less invasive.

### D4: Pad `forEachOrNull` on the source side

Change `forEachOrNull` from `list_transform(field, …).ifnull2([NULL])` to
`field.ifnull2([NULL]).list_transform((__el, __idxN) -> {…})`. The null row then flows through the
indexed lambda: `__el = NULL` (so leaf navigation yields `NULL`, unchanged) and the index is `1`,
so `%rowIndex = 0`. This is behavior-equivalent for the existing `forEachOrNull` results and adds
the correct index for the null row.

### D5: `repeat` uses the indexed lambda over the existing BFS accumulator

The `_repeat` body projection becomes an indexed `list_transform`, so `%rowIndex` is the element's
position in the (breadth-first) `reduceSource` accumulator. No change to `repeat-lowering.js`. This
intentionally does not match the reference pre-order numbering (see Non-Goals).

## Risks / Trade-offs

- [`repeat` sub-test left failing] → Accepted and documented as a known follow-up; the failure is
  ordering-only (BFS vs pre-order), not a compile or correctness regression for other repeat views,
  whose tests compare result **sets** and are unaffected.
- [Disambiguating projection vs iteration touches a hot, subtle code path] → Mitigated by the
  reference suite: all eight non-`repeat` `row_index.json` sub-tests plus the full existing
  `struct` spec suite must stay green, exercising root, `forEach`, `forEachOrNull`, nested, and both
  `unionAll` shapes.
- [Indexed-lambda arrow syntax emits a DuckDB deprecation warning] → Pre-existing across the whole
  emitter (all lambdas use `->`); no new exposure, addressed if/when the codebase migrates lambda
  syntax wholesale.
- [Staged backend diverges (supports `repeat` but not `%rowIndex`)] → Bounded by excluding
  `row_index.json` from `spec.staged.test.js`, mirroring the existing follow-up exclusion pattern.
