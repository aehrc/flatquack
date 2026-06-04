## 1. Engine extension (shared leaf compiler)

- [x] 1.1 Add an optional outer root-var parameter to `astToSql` in `src/ddb-sql-builder.js` (default `el`), used only for the scope-element reference (the `inLambda` nav root and the `this` case); internal `list_transform` lambda params stay `el` (design D2)
- [x] 1.2 Verify the `struct` emitter path is byte-for-byte unchanged when the param is omitted; run `tests/fp.test.js` and `tests/fp-custom.test.js`
- [x] 1.3 Add a thin leaf helper that reuses `_col`/`_col_collection` compilation and reshapes `name: <expr>` into `<expr> AS name`, preserving scalar `.as_value()` / collection `.ifnull2([])` semantics and the scalar-over-collection error (design D3)

## 2. Staged emitter — module scaffold and scope walk

- [x] 2.1 Create `src/staged-sql-builder.js` that walks the validated VD tree (reuse `validateVd`); per scope collect column leaves and fan-out children, and classify CHAIN (≤1 fan-out) vs FORK (≥2) (design D1, spec "Chain/Fork")
- [x] 2.2 Seed each scope's leaf compilation with the correct `schemaPath` (resource at root; the forEach path's element `outputType` for nested scopes); alias each unnest scope element `node` and pass it as the root-var
- [x] 2.3 Aggregate every leaf/forEach/where AST and produce the `columns=` schema via `extractPathsFromAst` + `pathsToSchema`, covering all paths in the VD (spec "Typed source CTE")
- [x] 2.4 Emit the first/source CTE using the existing source placeholders (`read_json_auto`/`source()` + `{{fq_sql_input_schema}}` + `{{fq_where_filter}}`), applying resource-type and `where` filters; reject a non-boolean `where` path (spec "Typed source CTE")

## 3. Staged emitter — chain mode

- [x] 3.1 Emit `column` projections at the owning stage (scalar vs `collection:true`) using the helper from 1.3 (spec "Column projection")
- [x] 3.2 Materialise each fan-out child's array as a named column in the parent stage; `UNNEST` the column in the child stage — never UNNEST a correlated path expression (design "Discipline 1")
- [x] 3.3 Implement `forEach` as INNER `, UNNEST(col)` and nested `select` (no fan-out) as same-stage column projection (spec "Chain scope lowering")
- [x] 3.4 Implement `forEachOrNull` via typed `[NULL]` padding `CASE WHEN len(arr)=0 THEN CAST([NULL] AS <elemType>[]) ELSE arr END` + `LEFT JOIN UNNEST(...) ON TRUE`, with `<elemType>` from the schema machinery (design D5, spec "forEachOrNull")

## 4. Staged emitter — fork mode, keys, unionAll

- [x] 4.1 Mint `rid = row_number() OVER ()` in the source CTE only when the VD contains a fork; emit no key for pure-chain views (design D4, spec "Lazy keys")
- [x] 4.2 At a FORK scope, emit each fan-out branch as its own staged sub-chain carrying the fork key, then recombine with `JOIN USING (key)` — INNER for `forEach`/`unionAll`, LEFT for `forEachOrNull` (spec "Fork scope keyed recombination")
- [x] 4.3 Extend the key with per-level ordinals (`UNNEST(...) WITH ORDINALITY` / `generate_subscripts`) on spines that reach a nested fork; root fork uses `rid` alone (design D4, spec "Nested fork composite key")
- [x] 4.4 Implement `unionAll` as `UNION ALL` of branch pipelines (chain) or one keyed branch (fork), requiring matching branch column names (spec "unionAll lowering")
- [x] 4.5 Emit the final `SELECT` as exactly the VD's columns by name in tree order; ensure keys/staging columns never leak or overwrite a VD column named `id` (spec "Output projection contract")
- [x] 4.6 Detect `repeat` and throw a clear "not supported by staged backend" error (spec "Unsupported directives")

## 5. Backend wiring and templates

- [x] 5.1 Add a `backend: 'staged' | 'struct'` option to `buildQuery`/`templateToQuery` in `src/query-builder.js`; `staged` returns the full `[WITH …] SELECT …` core (design D7)
- [x] 5.2 Add staged template(s) for the spec-test harness and `explore`, whose first CTE reuses the source mechanism and wraps the staged core in the sink shell (design D7; proposal: core query only)
- [x] 5.3 Refactor the `struct` templates: fold `AS result` into the expanded `{{fq_sql_transform_expression}}` and remove the literal `AS result` from `test-util` `testQueryTemplate`, `ndjson.sql`, `csv.sql`, `parquet.sql`, `dbt_model.sql`, `explore.sql`; confirm struct results unchanged (design D8)

## 6. Tests (do not modify the official reference JSON)

- [x] 6.1 Add a separate runner (e.g. `tests/spec.staged.test.js`) that executes the official `tests/spec-tests/*.json` suites through the `staged` backend, excluding `repeat.json` and any `%rowNumber` cases; reuse the existing view-execution approach in `tests/test-util.js`
- [x] 6.2 Confirm all non-`repeat` official suites pass on the staged backend; investigate and fix any failures in the emitter (not the test data)
- [x] 6.3 Add new emitter-specific test data in new JSON file(s) using the same harness format, covering the design-flagged gaps: nested fork (composite key correctness), key non-leakage, fork = per-parent cross product, `forEachOrNull` LEFT-join branch

## 7. Verification

- [x] 7.1 Run the full test suite (`bun test`); staged suites green, `repeat` still on `struct`, struct suites unchanged
- [x] 7.2 Spot-check generated staged SQL against `tests/generated-sql/SPEC_hybrid/` examples for structural resemblance (staged CTEs, chain vs fork, lazy keys); record any intentional differences from the typed binding
- [x] 7.3 `openspec validate add-staged-sql-emitter` passes
