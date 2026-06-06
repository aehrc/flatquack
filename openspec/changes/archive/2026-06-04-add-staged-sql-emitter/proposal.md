## Why

flatquack currently lowers a ViewDefinition into a single nested `result` STRUCT
that is then `CROSS JOIN UNNEST`-ed flat. For views with independent fan-out forks
(≥2 sibling `forEach`/`forEachOrNull` that each expand) this re-expands every branch
per outer row, which `SPEC_hybrid.md` measures as 5–25× slower than the staged
approach. We want an emitter that follows SPEC_hybrid — staged `UNNEST` chains, with
keyed recombination only at forks — while reusing the existing typed FHIRPath engine
and typed schema so the leaves stay typed (the measurably fastest binding).

## What Changes

- Add a **staged SQL emitter** that walks the ViewDefinition tree, classifies each
  `select` scope as CHAIN (≤1 fan-out child) or FORK (≥2), and emits staged CTEs:
  a root CTE, carry-forward chain stages, and — only at forks — branch CTEs
  recombined by an integer key (`rid` + per-level ordinals).
- The staged emitter reuses the existing engine for every leaf: `fhirpathToAst` +
  `astToSql` (nav/`where`/`exists`/comparison/literal/fn) for column and array-path
  expressions, and `extractPathsFromAst` + `pathsToSchema` for the typed `columns=`
  schema. The leaf binding stays **typed STRUCT navigation** (not JSON arrows); the
  generated SQL therefore resembles the SPEC_hybrid example structure with typed
  leaves. The spec governs structure; the example `.sql` files are illustrative.
- Add a **backend selector** to query building so a caller (and `spec.test.js`) can
  choose `staged` or the existing `struct` emitter. Staged becomes the default for
  non-`repeat` views.
- Add **emitter-specific templates** for the staged backend whose first CTE reuses
  the current source mechanism (`read_json_auto`/`source()` + `{{fq_sql_input_schema}}`
  + `{{fq_where_filter}}`), so csv/parquet/ndjson/dbt sinks compose unchanged.
- Refactor the existing `struct` templates so the magic name `result` is owned by the
  emitter: fold `AS result` into the expanded transform variable and drop the literal
  `AS result` from every struct template (test harness, ndjson, csv, parquet,
  dbt_model, explore).
- **Out of scope (this change):** `repeat` and `%rowNumber` are not implemented by the
  staged emitter; the staged backend errors clearly on `repeat`, and the existing
  `repeat` spec-tests remain excluded from the staged path.

## Capabilities

### New Capabilities
- `staged-sql-emitter`: Lowering a ViewDefinition into staged-CTE DuckDB SQL per
  SPEC_hybrid — CHAIN vs FORK scope classification, lazy integer fork keys, typed
  leaf binding via the existing FHIRPath engine, and a backend selector with
  emitter-specific source-compatible templates. Covers `column` (scalar/collection),
  `forEach`, `forEachOrNull`, nested `select`, `unionAll`, `where`, and resource
  filtering. Excludes `repeat` and `%rowNumber`.

### Modified Capabilities
<!-- No existing specs; the struct emitter behavior is unchanged at the requirement
     level (only the internal `result` naming/template wiring is refactored). -->

## Impact

- **New code:** `src/staged-sql-builder.js` (tree-walk + fork analysis + CTE emission);
  staged templates under `templates/`.
- **Modified code:** `src/query-builder.js` (backend selector; fold `AS result` into
  the struct transform variable). `src/ddb-sql-builder.js` may gain a small hook to
  root leaf navigation at an unnest element (or the emitter aliases the element `el`).
- **Modified templates:** all struct templates drop the literal `AS result`.
- **Tests:** `tests/spec.test.js` / `tests/test-util.js` gain backend selection; the
  staged backend runs the non-`repeat` suites (foreach, union, basic, where, fhirpath,
  logic, collection, view_resource, fn_*); `repeat` stays on `struct`/excluded.
- **No external API/dependency changes**; DuckDB and the FHIR R4 schema are unchanged.
