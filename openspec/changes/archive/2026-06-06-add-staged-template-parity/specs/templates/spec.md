## ADDED Requirements

### Requirement: Backend-aware built-in template resolution

FlatQuack SHALL resolve an `@name` built-in template to a file path that depends on the active
`--backend`. For `--backend staged`, resolution SHALL prefer `templates/staged/<name>.sql`; if that
file does not exist, resolution SHALL fall back to `templates/<name>.sql`. For `--backend struct`
(the default), resolution SHALL use `templates/<name>.sql`.

This resolution SHALL apply both to `--template @name` and to the default template selected by
`--mode explore`. Resolution of `--macros @name` SHALL remain backend-agnostic (always
`templates/<name>.sql`).

#### Scenario: Staged template selected for a staged build

- **WHEN** FlatQuack runs with `--backend staged --template @csv`
- **THEN** it SHALL load `templates/staged/csv.sql`

#### Scenario: Struct default unchanged

- **WHEN** FlatQuack runs with `--template @csv` and no `--backend` (or `--backend struct`)
- **THEN** it SHALL load `templates/csv.sql`

#### Scenario: Fallback when no staged variant exists

- **WHEN** FlatQuack runs with `--backend staged --template @name` and
  `templates/staged/<name>.sql` does not exist
- **THEN** it SHALL load `templates/<name>.sql` without error

#### Scenario: Explore default honors the backend

- **WHEN** FlatQuack runs with `--mode explore --backend staged` and no `--template`
- **THEN** it SHALL load `templates/staged/explore.sql`

### Requirement: Built-in template parity across backends

The built-in template catalog SHALL provide, for the `staged` backend, the same set of output
formats as for `struct`: `csv`, `parquet`, `ndjson`, `explore`, and `dbt_model`. Each staged
template SHALL emit a complete, runnable query for its output format using the staged variable
contract (`fq_staged_with`, `fq_staged_src`, `fq_staged_src_materialized`, `fq_staged_tail`), such
that switching from `--backend struct` to `--backend staged` for the same `@name` requires no other
change.

A staged file-export template (`csv`, `parquet`, `ndjson`) SHALL wrap the staged query body in the
format's `COPY … TO` output stage. The `explore` and `dbt_model` staged templates SHALL emit a bare
`SELECT`-yielding query with no `COPY` stage.

Backend-agnostic templates (`anonymize`, `dbt_prehook`) SHALL NOT be duplicated and SHALL resolve via
the fallback to the root file.

#### Scenario: Staged CSV export produces a COPY query

- **WHEN** a fan-out ViewDefinition is built with `--backend staged --template @csv`
- **THEN** the generated SQL SHALL be a `COPY ( … ) TO '<name>.csv' (FORMAT CSV …)` statement
  wrapping the staged CTE chain
- **AND** executing it SHALL write a CSV whose rows match the struct backend's output for the same
  view

#### Scenario: Same set available for both backends

- **WHEN** the built-in templates are enumerated for `struct` and for `staged`
- **THEN** both SHALL offer `csv`, `parquet`, `ndjson`, `explore`, and `dbt_model`

### Requirement: Staged templates emit required macros and explore semantics

A staged template SHALL emit both the base runtime macros (`fq_sql_macros`) and the view-specific
staged macros (`fq_staged_macros`) ahead of the query, because the staged path requires both and the
per-view staged macros cannot be hoisted into a shared prehook. The staged `dbt_model` template SHALL
inline `fq_staged_macros` rather than depend on a separate prehook.

The staged `explore` template SHALL apply its row limit inside the `src` (source) CTE, matching the
struct `explore` behavior (which limits the number of source resources read). Both backends SHALL
therefore behave identically for `explore`, including the case where a single source resource fans
out to more than the limit's worth of output rows.

#### Scenario: Staged template includes both macro blocks

- **WHEN** any staged file-export or dbt template is rendered
- **THEN** the output SHALL contain the base runtime macros and the view-specific staged macros
  before the first `WITH`/`COPY`

#### Scenario: Staged explore limits source rows like struct

- **WHEN** a ViewDefinition is run with `--mode explore --backend staged`
- **THEN** the staged `explore` template SHALL limit the number of **source resources** read (the
  `LIMIT` SHALL sit inside the `src` CTE)
- **AND** the resulting behavior SHALL match `--mode explore --backend struct` for the same view,
  including when a single source resource fans out to more than the limit's worth of output rows
