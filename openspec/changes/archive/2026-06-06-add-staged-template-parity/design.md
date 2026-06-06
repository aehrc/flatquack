# Design — staged template parity

## Context

There are two SQL emitters (`struct`, `staged`) that expose **different template variable
contracts** from `query-builder.js`:

```
            query part        struct slot                staged slot
           ┌──────────────┬──────────────────────────┬──────────────────────────┐
           │ macros       │ fq_sql_macros            │ fq_sql_macros + fq_staged_macros │
           │ WITH keyword │ (literal in template)    │ fq_staged_with (WITH[ RECURSIVE])│
           │ first CTE    │ (literal "transformed")  │ (literal "src")          │
           │ materialized │ —                        │ fq_staged_src_materialized│
           │ source FROM  │ (literal in template)    │ (literal in template)    │
           │ schema cols  │ fq_sql_input_schema      │ fq_sql_input_schema      │
           │ where        │ fq_where_filter          │ fq_where_filter          │
           │ select body  │ fq_sql_transform_expr    │ fq_staged_src            │
           │ CTE chain    │ —                        │ fq_staged_tail (incl.    │
           │ final SELECT │ fq_sql_flattening_cols + │   final SELECT)          │
           │              │ fq_sql_flattening_tables │                          │
           │ COPY/TO      │ (literal in template)    │ (literal in template)    │
           └──────────────┴──────────────────────────┴──────────────────────────┘
```

The seam between "template owns it" and "builder owns it" sits in a **different place** for each
backend: struct templates own the whole `WITH transformed … SELECT …` skeleton and the builder fills
two expression slots; staged templates own only the source CTE while the builder emits everything
from the `WITH` keyword through the final `SELECT` (in `fq_staged_tail`).

## Decision: parallel template set + backend-aware `@name` resolution

Two unification models were on the table:

1. **Unified skeleton vars** — rename both backends' pieces to a single set
   (`fq_with`/`fq_first_cte`/`fq_select_body`/`fq_rest`), collapsing each format to one template
   that serves both backends.
2. **Parallel template set** — keep struct templates as-is, add a staged set, and make `@name`
   resolution pick by `--backend`.

This change adopts **(2)** (per the spike decision). Rationale:

- **Zero regression risk to struct.** Struct templates stay byte-identical; only new files are added
  and the resolver is taught a new lookup path.
- **Each backend's template stays readable as itself.** A staged template literally shows the
  staged CTE shape; no indirection through renamed slots.
- **Format concerns stay in the template.** Source FROM (file glob vs. dbt `source()`), output
  format, and `LIMIT` placement remain template-local — important for `dbt_model` and `explore`.

The cost is duplication of the output wrapper across the two sets. (1) remains a viable future
consolidation once the parallel set is proven; it is explicitly deferred, not rejected.

## D1 — On-disk layout: `templates/staged/<name>.sql`

Staged variants live in a `staged/` subdirectory mirroring the root names:

```
templates/
  csv.sql            parquet.sql       ndjson.sql
  explore.sql        dbt_model.sql     dbt_prehook.sql
  anonymize.sql      duck-macros.js
  staged/
    csv.sql          parquet.sql       ndjson.sql
    explore.sql      dbt_model.sql
```

`anonymize.sql` (a `--macros` payload, not a `--template`) and `dbt_prehook.sql` (base macros only)
are backend-agnostic and get **no** staged variant — they resolve via fallback.

## D2 — Backend-aware resolution with fallback

`@name` resolution in `cli.js` becomes:

```
resolve(@name, backend):
  if backend == "staged" and exists templates/staged/<name>.sql:
      -> templates/staged/<name>.sql
  else:
      -> templates/<name>.sql        # struct default, and the staged fallback
```

This applies to `--template @name` and the `explore`-mode default template. The `--macros @name`
resolution is **not** backend-aware (macros are backend-agnostic; `@anonymize` is shared).

## D3 — Staged templates carry both macro blocks

A staged file emits both macro blocks at the top, before `COPY`:

```sql
{{fq_sql_macros}}
{{fq_staged_macros}}
COPY (
    {{fq_staged_with}} src AS {{fq_staged_src_materialized}}(
        SELECT {{fq_staged_src}}
        FROM read_json_auto('{{fq_input_dir}}/**/*{{fq_vd_resource}}*.ndjson' {{fq_sql_input_schema}})
        {{fq_where_filter}}
    ){{fq_staged_tail}}
) TO '{{fq_output_dir}}/{{fq_vd_name}}.csv' (FORMAT CSV, DELIMITER ',', HEADER);
```

`fq_sql_macros` is the base runtime macro set; `fq_staged_macros` is the **view-specific** staged
macro block produced by the staged build. The latter cannot be hoisted into a shared `dbt_prehook`
because it varies per ViewDefinition — which is exactly why the staged `dbt_model` template inlines
`fq_staged_macros` itself rather than relying on a prehook.

## D4 — `explore` matches struct's source-row limit

The struct `explore.sql` places `LIMIT 10` inside the `transformed` (source) CTE, so it limits the
number of **source resources** read, not the number of output rows — under fan-out a single source
resource can still yield more than 10 output rows. To keep both backends behaving identically,
the staged `explore.sql` places `LIMIT 10` inside its `src` CTE as well (before `{{fq_staged_tail}}`),
giving the same source-row-limit semantics as struct.

(An alternative — trailing the limit after `{{fq_staged_tail}}` for true final-output-row semantics —
was considered and rejected in the spike in favor of exact parity with the existing struct behavior.
Aligning struct's explore to a final-output limit, and updating its "up to 10 results" wording, is a
possible separate follow-up.)

## D5 — Remove `scripts/gen-staged.js`

It carried an inline staged skeleton with a `{{SOURCE}}` placeholder for `benchmark/explain.sh`, has
no remaining references besides its own usage string, and is superseded by the shipped staged
templates. Removed. Test fixtures (`tests/test-util.js`) already define `stagedQueryTemplate`
parallel to `testQueryTemplate` and stay inline, unchanged.

## Risks / trade-offs

- **Duplication of the output wrapper** between root and `staged/`. Accepted for now; the unified-vars
  path remains available as a later consolidation.
- **Fallback opacity** — a user who edits `templates/csv.sql` expecting it to affect
  `--backend staged` will not see an effect once a `templates/staged/csv.sql` exists. Documented in
  the README template section.
