## Why

The `staged` (SPEC_hybrid) backend has reached functional parity with `struct` (fan-out forks,
`repeat`, `%rowIndex`), but the **template layer never caught up**. Every shipped template
(`@csv`, `@parquet`, `@ndjson`, `@explore`, `@dbt_model`) references only the struct slots
(`fq_sql_transform_expression`, `fq_sql_flattening_cols`, `fq_sql_flattening_tables`) and ignores
the `fq_staged_*` slots that `query-builder.js` already computes. As a result
`--backend staged --template @csv` silently produces struct-shaped (or empty) SQL — there is no
shipped template that emits a staged query into a real output format (CSV/Parquet/NDJSON file).

The only staged template skeletons that exist live as ad-hoc strings inside `scripts/gen-staged.js`
and `tests/test-util.js`, and neither wraps the staged body in a `COPY … TO` output stage. A user
cannot today run the staged backend through the CLI to produce a file.

The goal is to support the **same set of built-in templates for `staged` as for `struct`**, with
minimal duplication, so that flipping `--backend` is the only change a user needs to make.

## What Changes

- Make built-in `@name` template resolution **backend-aware**: `--backend staged` resolves `@csv`
  to `templates/staged/csv.sql`; `--backend struct` (default) resolves to `templates/csv.sql` as
  today. When no staged variant exists, resolution **falls back** to the root (struct) file, so
  backend-agnostic templates are not duplicated.
- Add a parallel staged template set under `templates/staged/`: `csv.sql`, `parquet.sql`,
  `ndjson.sql`, `explore.sql`, `dbt_model.sql` — full parity with the struct set. Each wraps the
  staged CTE skeleton (`fq_staged_with` / `fq_staged_src` / `fq_staged_src_materialized` /
  `fq_staged_tail`) in the format's output stage (`COPY … TO` for file exports; bare `SELECT` for
  `explore`/`dbt_model`).
- Staged templates emit **both** macro blocks at the top — base runtime macros (`fq_sql_macros`)
  and the view-specific staged macros (`fq_staged_macros`) — since the staged path needs both and
  the per-view staged macros cannot be hoisted into a shared prehook.
- `@explore` (staged) applies `LIMIT` inside the `src` CTE, matching the struct `explore` behavior
  exactly (struct limits source resources read, not final output rows).
- Delete `scripts/gen-staged.js` (its inline `{{SOURCE}}` template is superseded; only
  self-referenced).
- Refresh `README.md`: document `--backend`, `--root-key`, `--repeat-depth`; document the
  `fq_staged_*` template variables; note that built-in `@name` templates resolve per backend; link
  `docs/SPEC_hybrid.md`.

Non-goals:
- No change to the struct templates (kept byte-identical → zero regression risk).
- No unification of struct and staged into a single shared template (a "unified skeleton vars"
  approach was considered and deferred; see design). This change deliberately favors a parallel set
  with backend-aware resolution.
- No change to the staged emitter (`staged-sql-builder.js`) or the template variable contract in
  `query-builder.js`.
- Test fixtures in `tests/test-util.js` are already parallel (`testQueryTemplate` /
  `stagedQueryTemplate`) and stay inline, unchanged.

## Capabilities

### New Capabilities
- `templates`: built-in template catalog and backend-aware `@name` resolution, including the
  requirement that the same built-in template set works for both `struct` and `staged`.

### Modified Capabilities
<!-- none — emitters unchanged -->

## Impact

- `src/cli.js`: backend-aware `@name` resolution for `--template` (and the `explore`-mode default)
  with fallback to the root file; help text mentions `--backend` template selection.
- `templates/staged/{csv,parquet,ndjson,explore,dbt_model}.sql`: new files.
- `scripts/gen-staged.js`: deleted.
- `README.md`: documentation refresh (new CLI flags, staged template vars, backend-aware resolution,
  SPEC_hybrid link).
- No change to `src/staged-sql-builder.js`, `src/query-builder.js` variable contract, or
  `tests/test-util.js`.
