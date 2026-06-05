## Why

The SQL-on-FHIR `%rowIndex` environment variable (the 0-based position of the current element
within the enclosing iteration) is unsupported on the `struct` backend: any view referencing it
fails at compile time with `Variable %rowIndex is not defined`, because the FHIRPath parser routes
all `%`-constants through the `--var` lookup. The `row_index.json` reference suite therefore cannot
run on the default backend.

## What Changes

- Recognize `%rowIndex` in the FHIRPath parser as a contextual environment variable (a dedicated
  AST segment) rather than a user-supplied `--var`, so it no longer throws.
- Emit `%rowIndex` on the `struct` backend by threading a current-row-index SQL expression through
  the emitter: real `forEach`/`forEachOrNull`/`repeat` iteration opens an indexed `list_transform`
  lambda `(__el, __idxN)` and binds `%rowIndex` to `(__idxN - 1)`; outside any iteration it is `0`.
- Distinguish the emitter's two uses of the `_forEach` directive — **projection** wrappers (resource
  root, `select`, `unionAll` branches; NOT iteration) versus real **iteration** (`field._forEach(…)`)
  — so a `unionAll` branch without its own `forEach` inherits the enclosing iteration's index instead
  of resetting to its single-element wrapper.
- Make `forEachOrNull` pad its null row on the **source** side so the synthesized null row flows
  through the indexed lambda and reports `%rowIndex = 0` (behavior-equivalent for existing tests).
- Scope: `struct` backend only. `%rowIndex` over `repeat` is emitted using the existing
  breadth-first accumulator order; the one `repeat` sub-test that pins depth-first pre-order
  numbering is a **known follow-up** and is left failing. Staged-backend parity is out of scope and
  the `row_index.json` suite is excluded from the staged test runner.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `struct-sql-emitter`: adds a requirement for `%rowIndex` support (contextual indexing across
  resource root, `forEach`, `forEachOrNull`, nested `forEach`, `unionAll`, and `repeat`), with the
  `repeat` pre-order sub-case explicitly out of scope.

## Impact

- `src/fhirpath-parser.js`: `%rowIndex` recognized as a contextual segment (no `--var` throw).
- `src/ddb-sql-builder.js`: thread row-index SQL; indexed lambdas in `_forEach`/`_repeat`;
  source-side null-pad for `forEachOrNull`; resolve the `rowIndex` segment.
- `src/view-parser.js`: disambiguate projection vs iteration `_forEach`.
- `tests/spec.staged.test.js`: exclude `row_index.json` (staged parity is a follow-up).
- No public CLI/API surface changes; existing `--var` behavior for other constants is unchanged.
