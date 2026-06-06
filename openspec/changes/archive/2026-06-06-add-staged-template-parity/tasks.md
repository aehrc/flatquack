## 1. Backend-aware `@name` resolution

- [x] 1.1 In `src/cli.js`, factor `@name` → path resolution into a helper that takes the backend
      (D2): `staged` first tries `templates/staged/<name>.sql`, else falls back to
      `templates/<name>.sql`; `struct` uses `templates/<name>.sql`
- [x] 1.2 Apply the helper to `--template @name` resolution
- [x] 1.3 Apply the helper to the `explore`-mode default template (so `--mode explore --backend
      staged` picks `templates/staged/explore.sql`)
- [x] 1.4 Leave `--macros @name` resolution backend-agnostic (unchanged)
- [x] 1.5 Confirm a missing staged variant falls back to the root file (e.g. a hypothetical
      `@anonymize` as a template) without error

## 2. Staged template set (`templates/staged/`)

- [x] 2.1 `csv.sql`: both macro blocks at top + `COPY ( <staged CTE skeleton> ) TO '….csv'
      (FORMAT CSV, DELIMITER ',', HEADER)` (D3)
- [x] 2.2 `parquet.sql`: same wrapper, `TO '….parquet' (FORMAT PARQUET)`
- [x] 2.3 `ndjson.sql`: same wrapper, `TO '….ndjson' (FORMAT JSON)`
- [x] 2.4 `explore.sql`: both macro blocks + bare staged skeleton, trailing `LIMIT 10` after
      `{{fq_staged_tail}}` (final-output limit, D4); no `COPY`
- [x] 2.5 `dbt_model.sql`: staged skeleton reading from `{{ source('fhir_db', '{{fq_vd_resource}}') }}`,
      inlining `{{fq_staged_macros}}` (no prehook reliance, D3); no `COPY`

## 3. Remove superseded script

- [x] 3.1 Delete `scripts/gen-staged.js` (D5); confirm no remaining references (benchmark scripts,
      package.json)

## 4. Verification

- [x] 4.1 `--backend staged --template @csv` on a fork view: generated SQL is a valid `COPY … TO`
      staged query; run it and confirm a CSV is written with correct rows
- [x] 4.2 Repeat for `@parquet`, `@ndjson`
- [x] 4.3 `--mode explore --backend staged` returns ≤10 final output rows (not source-limited) on a
      fan-out view; compare row shape against the struct explore output
- [x] 4.4 `--backend staged --template @dbt_model`: generated SQL reads from the dbt source and
      carries staged macros inline
- [x] 4.5 Confirm `--backend struct` output for every built-in template is byte-identical to before
      this change (struct templates untouched)
- [x] 4.6 Run the full test suite (`bun test`) — no regressions

## 5. Documentation

- [x] 5.1 README: add `--backend`, `--root-key`, `--repeat-depth` to the CLI arguments table
- [x] 5.2 README: note that built-in `@name` templates resolve per `--backend`, with fallback to the
      struct file; document the implication for users editing root templates
- [x] 5.3 README: document the `fq_staged_*` template variables (`fq_staged_with`, `fq_staged_src`,
      `fq_staged_src_materialized`, `fq_staged_tail`, `fq_staged_macros`)
- [x] 5.4 README: link `docs/SPEC_hybrid.md` and add a short "choosing a backend" note
      (staged for `repeat` + deep fan-out forks)
