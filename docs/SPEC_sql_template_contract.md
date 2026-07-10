# SQL Template Contract — the emitter/template seam

How a flatquack **template** combines with the emitter's generated SQL to produce a
runnable DuckDB statement. A template is a contract between two authors: the
**template** owns *data acquisition* (where rows come from), the *output sink*
(where they go), and *setup* (macro placement); the **emitter** owns the
*transformation* — the chain of CTEs that flattens a resource into the view's rows
(see [SPEC_view_lowering.md](./SPEC_view_lowering.md)).

The whole design rests on one decision: **the two authors meet at exactly two named
CTEs.** The template binds an **input** relation; the emitter's sealed **pipeline**
consumes it and produces an **output** relation; the template consumes that. Nothing
in between is a template concern.

```
   template provides ─▶  _fq_input  ─▶  [ fq_sql_pipeline ]  ─▶  _fq_output  ─▶ template consumes
   (resource columns)                  (sealed flattening)      (flat columns)
```

Implementation: `src/query-builder.js` (`templateToQuery` — variable substitution),
`src/staged-sql-builder.js` (the pipeline and the `_fq_input`/`_fq_output` CTEs),
`templates/*.sql` (the built-in templates).

---

## 1. The seam

A template is plain text with `{{fq_…}}` placeholders that `templateToQuery`
substitutes. The placeholders fall into three groups:

- **edges** the template controls — the output-statement wrapper (`COPY`/`CREATE`/
  bare), the data source, and where macros load;
- the **seam** — two CTE names the emitter generates (`fq_sql_input`,
  `fq_sql_output`) plus their column metadata;
- **metadata** — paths and view names (`fq_input_dir`, `fq_vd_name`, …).

The emitter's pipeline is **sealed**: its internal CTEs and their names are private.
The template never writes a CTE name itself — it echoes the emitter-generated
`fq_sql_input` / `fq_sql_output`, so there are no template-invented identifiers and
no collisions.

## 2. Variable reference

| Variable | Owner | Content |
|---|---|---|
| `fq_input_dir` / `fq_output_dir` | env | working directories |
| `fq_vd_name` / `fq_vd_resource` | metadata | view name, resource type |
| `fq_sql_macros` | emitter | base DuckDB macros — static, identical every run |
| `fq_sql_view_macros` | emitter | per-view `from_json` cast macros — generated per ViewDefinition |
| `fq_sql_with` | emitter | `WITH` or `WITH RECURSIVE` (recursion is emitter-decided) |
| `fq_sql_input` | emitter | input CTE name (`_fq_input`) |
| `fq_sql_input_schema` | emitter | typed read columns `, columns={…}` — empty when untyped |
| `fq_sql_where` | emitter | `WHERE …` — empty when the view has no filter |
| `fq_sql_pipeline` | emitter | the sealed CTE list (no edge commas, no terminal `SELECT`) |
| `fq_sql_output_columns` | emitter | the public columns, in order |
| `fq_sql_output` | emitter | output CTE name (`_fq_output`) |

## 3. The pipeline contract

`fq_sql_pipeline` is a function over CTEs: it **expects** an input relation and
**produces** an output relation.

**Expects — the input CTE.** A CTE named `{{fq_sql_input}}` whose top-level columns
are the FHIR resource's elements (specifically those named in
`{{fq_sql_input_schema}}`). Most common case — read newline-delimited JSON with the
typed schema and apply the row filter:

```sql
{{fq_sql_with}} {{fq_sql_input}} AS (
    SELECT * FROM read_json_auto('…'{{fq_sql_input_schema}})
    {{fq_sql_where}}
),
```

`{{fq_sql_with}}` supplies `WITH`/`WITH RECURSIVE`; the trailing comma joins the
input CTE to the pipeline. Any relation exposing those columns works — a dbt source,
a table, a `UNION`, a join.

**Produces — the output CTE.** A CTE named `{{fq_sql_output}}` containing exactly the
flattened public columns, in order (`{{fq_sql_output_columns}}`). Most common case —
project it as the final `SELECT`:

```sql
{{fq_sql_pipeline}}
SELECT {{fq_sql_output_columns}} FROM {{fq_sql_output}}
```

## 4. Invariants

1. **Parenthesizable query.** The assembled `WITH … SELECT` is a complete, embeddable
   query with no trailing `;`. The statement wrapper — `COPY (…) TO`,
   `CREATE TABLE … AS`, `INSERT INTO`, or nothing — is entirely the template's.
2. **Private names.** Pipeline CTE names are reserved (`_fq_` prefix) and surfaced
   only through `fq_sql_input` / `fq_sql_output`. Templates never invent them.
3. **Comma ownership.** `fq_sql_pipeline` carries no leading or trailing comma; the
   template owns the commas adjacent to *its* CTEs. Possibly-empty fragments
   (`fq_sql_input_schema`, `fq_sql_where`) self-include their leading separator so
   they vanish cleanly when empty.
4. **Column-clean output.** `fq_sql_output` contains *exactly* the public columns, in
   order — no internal bookkeeping. So `SELECT *` / `r.*` over it is leak-safe, and
   `fq_sql_output_columns` is an exact, ordered match (which CSV headers and Parquet
   schemas rely on).
5. **Emitter-decided correctness.** `WITH RECURSIVE` is emitted only when the view
   recurses; `MATERIALIZED` is applied to internal CTEs where required (e.g. a
   volatile uuid root key). Templates may *additionally* materialize their own input
   CTE (see §7).

## 5. Extension

Because the template owns the front and back of the `WITH` list, it can add its own
CTEs at either end.

**Front** — define a relation the input then uses (e.g. load a lookup once):

```sql
{{fq_sql_with}} ref AS (SELECT … FROM read_csv('codes.csv')),
                {{fq_sql_input}} AS (SELECT * FROM read_json_auto('…') r JOIN ref USING (code)),
{{fq_sql_pipeline}}
SELECT {{fq_sql_output_columns}} FROM {{fq_sql_output}}
```

**End** — enrich/reshape the flat result (`{{fq_sql_output}}` is leak-safe to `r.*`):

```sql
{{fq_sql_pipeline}},
  enriched AS (SELECT r.*, d.display FROM {{fq_sql_output}} r LEFT JOIN code_display d ON r.code = d.code)
SELECT * FROM enriched
```

## 6. Macros & setup

`fq_sql_macros` (base) and `fq_sql_view_macros` (per-view casts) are
`CREATE OR REPLACE MACRO` statements that must run **before** the query. File
templates inline both at the top; dbt routes both to the prehook (a dbt model is a
single `SELECT`, so it carries no macro statements). The two are kept separate
because base macros are static and shareable (load once project-wide) while view
macros are regenerated per ViewDefinition.

## 7. Built-in templates

**File output** (`csv` / `ndjson` / `parquet`) — typed read, row filter, output sink:

```sql
{{fq_sql_macros}}
{{fq_sql_view_macros}}
COPY (
  {{fq_sql_with}} {{fq_sql_input}} AS (
      SELECT * FROM read_json_auto('{{fq_input_dir}}/**/*{{fq_vd_resource}}*.ndjson'{{fq_sql_input_schema}})
      {{fq_sql_where}}
  ),
  {{fq_sql_pipeline}}
  SELECT {{fq_sql_output_columns}} FROM {{fq_sql_output}}
)
TO '{{fq_output_dir}}/{{fq_vd_name}}.ndjson' (FORMAT JSON);
```

**explore** — bare `SELECT`, previews the first rows. The input is **`MATERIALIZED`**:
`LIMIT` without `ORDER BY` is non-deterministic, and a forked view evaluates the input
once per branch, so without materialization the branches could see different rows and
the fork recombination would mismatch. The same rule applies to any custom template
that combines a non-deterministic source op (`LIMIT`, `SAMPLE`, `random()`) with a
forked view.

```sql
{{fq_sql_macros}}
{{fq_sql_view_macros}}
{{fq_sql_with}} {{fq_sql_input}} AS MATERIALIZED (
    SELECT * FROM read_json_auto('{{fq_input_dir}}/**/*{{fq_vd_resource}}*.ndjson'{{fq_sql_input_schema}})
    {{fq_sql_where}}
    LIMIT 10
),
{{fq_sql_pipeline}}
SELECT {{fq_sql_output_columns}} FROM {{fq_sql_output}}
```

**dbt** — `dbt_model` is a pure `SELECT` reading from a dbt source; `dbt_prehook`
carries both macro blocks:

```sql
-- dbt_model
{{fq_sql_with}} {{fq_sql_input}} AS (
    SELECT * FROM {{ source('fhir_db', '{{fq_vd_resource}}') }}
    {{fq_sql_where}}
),
{{fq_sql_pipeline}}
SELECT {{fq_sql_output_columns}} FROM {{fq_sql_output}}

-- dbt_prehook
{{fq_sql_macros}}
{{fq_sql_view_macros}}
```

## 8. Design notes

- The seam was once a *syntactic hole* (the source spliced into the emitter's first
  CTE). Making it a *named relation* (`_fq_input`) keeps the template's half legible —
  "provide a typed input relation" — and seals the projection, recursion keyword, and
  any `MATERIALIZED` hint inside the pipeline.
- The `fq_sql_pipeline` / `fq_sql_output` / `fq_sql_output_columns` split exists to
  allow end-extension (§5). It is the only path — there is no precomposed "tail"
  variable — so every template writes the terminal `SELECT`, and the column-clean
  output invariant (§4.4) is what makes the extension joins safe.
- All SQL-construction variables use the `fq_sql_` prefix; environment and view
  metadata use `fq_`.
