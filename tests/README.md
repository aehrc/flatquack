# Tests

Run everything with `bun test`.

## Layout

| Path | What it is |
|------|------------|
| `spec-tests/` | **Official** SQL-on-FHIR conformance fixtures — a verbatim mirror of [`FHIR/sql-on-fhir.js`](https://github.com/FHIR/sql-on-fhir.js) `/tests`. **Do not edit or add files here** (see [memory: spec-tests are read-only]). `spec-tests/skip/` holds fixtures for spec features not yet implemented. |
| `custom-tests/` | **Flatquack-specific** fixtures in the same JSON format, covering behaviour and regressions beyond the official suite: the staged (hybrid) emitter's fork handling (`staged.json`), extended `%rowIndex`-over-`repeat` cases (`row_index_repeat.json`), repeat regressions (`repeat_extra.json`), and reserved column-name collisions (`reserved_names.json`). The `repeat` directive and `%rowIndex` themselves are official spec features — their fixtures live in `spec-tests/`. |
| `.tmp/` | Scratch dir for the generated `*.temp.json` resource files the runners feed to DuckDB. Git-ignored; safe to delete. |

## Runners

Both suites are driven by `runFixtureSuite` in `test-util.js`, which compiles every fixture through
the staged emitter in **both** root-fork key modes (`natural` and `uuid`) and compares results as
order-independent Sets (plus optional `expectColumns`):

- `spec.staged.test.js` → runs `spec-tests/` (official).
- `custom.staged.test.js` → runs `custom-tests/` (flatquack).

Non-fixture tests that cannot be expressed as data live in their own JS files, e.g.
`staged-sql-shape.test.js` (asserts on emitted SQL text) and `view-parser.test.js`
(`validateVd` unit tests).

## Fixture format

Standard SQL-on-FHIR test JSON: top-level `title`, `resources`, and a `tests` array of cases, each
with a `view` (ViewDefinition) plus `expect` rows and/or `expectColumns`. Also supported:
`skip`/`only` (file and test level) and `expectError`.

**Custom-suite extension:** a case in `custom-tests/` may carry its own `resources` array, which
overrides the file's top-level `resources`. This lets one fixture file hold cases that need
different input data. The official `spec-tests/` fixtures never use this — they keep one shared
top-level `resources`.
