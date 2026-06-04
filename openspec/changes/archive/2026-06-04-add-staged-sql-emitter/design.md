  ## Context

flatquack lowers a ViewDefinition to DuckDB SQL in three layers (`src/`):

- `fhirpath-parser.js` — `fhirpathToAst(path, seedSchemaPath, schema)` produces a typed
  AST; every nav step carries its FHIR type/`schemaPath` from `schemas/fhir-schema-r4.json`.
- `ddb-sql-builder.js` — `astToSql(ast, inLambda, inputType)` compiles a path to SQL;
  `extractPathsFromAst` + `pathsToSchema` produce the typed `columns=STRUCT(...)` schema.
- `view-parser.js` + `query-builder.js` — the **struct emitter**: `parseVd` flattens the
  whole VD into one pseudo-FHIRPath (`_col`/`_forEach`/`_unionAll`), `astToSql` builds one
  nested `result` STRUCT, and `tablesToSql` flattens it with `CROSS/LEFT JOIN UNNEST`.

The flattening discards the VD tree, so per-scope decisions (chain vs fork) are impossible
in the struct emitter, and sibling fan-outs re-expand per outer row (SPEC_hybrid: 5–25×
slower on a nested fork). This change adds a second emitter that follows
`specs/SPEC_hybrid.md` while reusing the typed leaf engine unchanged.

The riskiest mechanics were validated with DuckDB probes before this design (see Decisions).

## Goals / Non-Goals

**Goals:**
- A `staged` emitter producing SPEC_hybrid-shaped staged CTEs (root CTE → carry-forward
  chain stages → fork branch CTEs recombined by an integer key).
- Reuse the existing FHIRPath engine and typed schema verbatim for every leaf
  (column paths, forEach array paths, where predicates) — leaves stay **typed STRUCT
  navigation**, the measurably fastest binding.
- A backend selector so callers / `spec.test.js` pick `staged` or `struct`.
- Emitter-specific templates whose first CTE reuses the existing source mechanism
  (`read_json_auto`/`source()` + `{{fq_sql_input_schema}}` + `{{fq_where_filter}}`) so all
  sinks (csv/parquet/ndjson/dbt/explore) compose unchanged.
- Pass the non-`repeat` spec-test suites through the staged backend.

**Non-Goals:**
- `repeat` and `%rowNumber` (staged backend errors clearly on `repeat`; repeat suites stay
  on the struct backend / excluded).
- Replacing or removing the struct emitter (it stays as the default for `repeat` views and
  the fallback backend).
- Performance benchmarking / the typed-vs-JSON measurement (covered by SPEC_hybrid itself).
- New output formats or external dependencies.

## Decisions

### D1 — A tree-walking emitter, not the flattened path

`parseVd`'s flattened path destroys the per-scope structure the fork analysis needs, so the
staged emitter walks the validated VD JSON directly (reusing `validateVd`). For each
`select` scope it: projects columns, counts **fan-out children**
(`forEach`/`forEachOrNull`, and a `unionAll` whose branches fan out), and classifies the
scope **CHAIN** (≤1 fan-out) or **FORK** (≥2). This mirrors SPEC_hybrid §3/§6.

*Alternative considered:* enrich `parseVd` to keep the tree. Rejected — it would entangle
the two emitters; a separate walker keeps the struct emitter untouched.

### D2 — Reuse the leaf engine via a configurable outer root variable (the central enabler)

Each leaf (column path, forEach array path) is compiled by the **existing**
`fhirpathToAst` + `astToSql`, seeded with the current scope's `schemaPath`:
- **Root scope** → non-lambda mode → bare typed columns: `id`, `name`,
  `name.list_transform(el -> el.given).flatten()` (read directly from `read_json_auto`).
- **Nested scope** → the unnested element is a STRUCT; leaves compile in lambda mode →
  `(el.family)`, `(el.telecom).list_transform(el -> el.system)`.

**Probe finding (decisive):** DuckDB resolves `el.member` to a *column* named `el` in
preference to a same-named lambda parameter. So aliasing the unnest element `el` breaks any
nested navigation (`el.system` inside `list_transform`) — confirmed:
`list_transform(el.telecom, el -> el.system)` with an `el` column → `Could not find key
"system"`. Renaming either side fixes it.

**Decision:** alias each unnest scope element a distinct name (`node`) and **extend
`astToSql` to take an outer root-var name** (default `el`) used only for the scope-element
reference (the `inLambda` nav root and `$this`); internal `list_transform` lambda params
stay `el`. With `node`-aliased elements, `(node.telecom).list_transform(el -> el.system)`
binds correctly (validated end-to-end). This is a small, additive engine change that the
struct emitter is unaffected by (it keeps the `el` default).

*Alternatives:* (a) rename the engine's internal lambda params — rejected, they nest and
re-shadow and the struct emitter relies on `el`. (b) regex-rewrite `el` in emitted SQL —
rejected, ambiguous with internal lambdas.

### D3 — Scalar/collection leaf shaping reuses `_col` semantics

A scalar `column` whose path returns a collection must slice to one value (`.as_value()`);
a `collection:true` column keeps the array (`.ifnull2([])`). Rather than re-derive this, the
emitter reuses the existing `_col`/`_col_collection` compilation and reshapes its
`name: <expr>` output into `<expr> AS name` (or a thin shared helper applying the identical
rule). This guarantees parity with the struct emitter's column behavior and validation
(e.g. the "scalar path returned a collection" runtime error).

### D4 — Lazy integer fork keys

Per SPEC_hybrid §4: `rid = row_number() OVER ()` is minted in the root CTE **only if the VD
contains a fork**; pure-chain views mint no key and emit no join. At a **root** fork the key
is `rid`; at a **nested** fork it is `(rid, ord_1, …)` where each `ord_i` is the iterating
step's ordinal, emitted via `UNNEST(...) WITH ORDINALITY` / `generate_subscripts` only on
spines that reach a fork. Branches recombine by `JOIN USING (key)` — `INNER` for
`forEach`/`unionAll`, `LEFT` for `forEachOrNull`. Validated: a root fork rid-join produces
the correct per-resource cross product and drops resources whose INNER branch is empty.

### D5 — `forEachOrNull` via `LEFT JOIN UNNEST … ON TRUE` (no padding)

A plain `, UNNEST(arr)` of an empty list yields 0 rows; `forEachOrNull` needs one NULL row.
**Implementation finding (simpler than first planned):** `LEFT JOIN UNNEST(arr) AS _u(node)
ON TRUE` already yields a single NULL row when `arr` is empty — verified for typed
`STRUCT[]` and scalar lists alike. So no typed `[NULL]` padding is needed; `forEach` is
`, UNNEST(col)` (INNER) and `forEachOrNull` is `LEFT JOIN UNNEST(col) ON TRUE`, both over a
**materialised** column (Discipline 1). In a fork, a `forEachOrNull` branch additionally
recombines with a `LEFT JOIN … USING (key)`. (The earlier padding plan was dropped once the
LEFT-JOIN behaviour was confirmed; it would have been equivalent but more code.)

### D6 — `unionAll` as branch pipelines

In a chain scope, a `unionAll` lowers to `UNION ALL` of branch sub-pipelines with identical
column lists (SPEC_hybrid §5). At a fork scope it is one keyed branch like any other. This
matches the existing `unionAll` validation (matching column names across branches) and the
example `.sql`.

### D7 — Backend selector + emitter-specific, source-compatible templates

`query-builder.js` gains a `backend: 'staged' | 'struct'` option. The `staged` path returns
a complete `[WITH …] SELECT …` core whose **first CTE** reuses the current source
placeholders (`read_json_auto`/`source()`, `{{fq_sql_input_schema}}`, `{{fq_where_filter}}`);
the remaining CTEs are emitter-produced. Staged templates are added per sink, each being the
existing sink shell (`COPY ( … ) TO … (FORMAT …)` / `LIMIT` / dbt) wrapping the staged core.
This change wires the staged core into the spec-test harness + `explore` (proposal: *core
query only*); the other sinks are mechanical follow-ups using the same shell.

### D8 — Refactor the struct templates' `result` naming

`result` is an emitter-internal name referenced by three expansions, but only `AS result` is
hard-coded in the templates while `result.id` / `UNNEST(result.e_1)` come from the emitter.
Fold `AS result` into the expanded `{{fq_sql_transform_expression}}` and drop the literal
`AS result` from every struct template (`test-util` `testQueryTemplate`, `ndjson`, `csv`,
`parquet`, `dbt_model`, `explore`). Pure refactor — no struct-emitter behavior change.

## Risks / Trade-offs

- **Engine root-var change touches a shared file (`ddb-sql-builder.js`)** → keep the param
  optional with default `el`; the struct emitter passes nothing and is byte-for-byte
  unchanged; cover with the existing `fp.test.js`/`fp-custom.test.js`.
- **Nested forks are under-exercised by current tests** (root forks, chains, unions are
  covered) → implement the general composite-key path per §6 but treat nested-fork ordinals
  as the part most needing added tests; if a current suite has no nested fork, add one.
- **Correlated `UNNEST` of a materialised array vs. an inline expression** → always
  materialise the next-level array as a *named column* in the parent stage and `UNNEST` the
  column (SPEC_hybrid Discipline 1); never `UNNEST` a correlated path expression.
- **`unionAll` column ordering** must match across branches for `UNION ALL` → reuse the
  existing unionAll validation; project branches by explicit name list.
- **Two emitters can drift** → both share the leaf engine + schema + macros + `_col`
  semantics; only the structural composition differs, limiting divergence to the walker.
- **`repeat` reaching the staged backend** → detect a `repeat` node and throw a clear
  "not supported by staged backend" error; route repeat suites to `struct`.
