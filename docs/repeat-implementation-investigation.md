# Implementing `repeat` in FlatQuack — Investigation Report

## Background

SQL on FHIR v2 defines the `repeat` element for recursively traversing nested FHIR structures to arbitrary depth. The canonical use case is `QuestionnaireResponse`, where items contain answers, answers contain sub-items, and this nesting can continue indefinitely.

```json
{
    "repeat": ["item", "answer.item"],
    "column": [
        { "name": "link_id", "path": "linkId" },
        { "name": "answer_text", "path": "answer.value.ofType(string).first()" }
    ]
}
```

FlatQuack currently supports `forEach` and `forEachOrNull` but not `repeat`. This document summarizes the investigation into how to add `repeat` support.

## FlatQuack Architecture (Relevant to `repeat`)

FlatQuack is a **compiler** that transforms ViewDefinitions into DuckDB SQL. The pipeline:

```
ViewDefinition → view-parser.js → fhirpath-parser.js → ddb-sql-builder.js → SQL template
```

The compilation uses a **two-phase flattening** pattern:

1. **Phase 1 (SELECT):** Build nested struct/list expressions using `list_transform`, producing a result struct with list columns for each `forEach` block.
2. **Phase 2 (FROM):** `UNNEST` those lists via `CROSS JOIN UNNEST` (or `LEFT JOIN UNNEST` for `forEachOrNull`) to produce flat rows.

Example generated SQL for `forEach: "name"`:
```sql
WITH transformed AS (
    SELECT {
        id: id,
        e_1: name.list_transform(el -> {family: el.family})
    } AS result
    FROM read_json_auto('...', columns={id: 'VARCHAR', name: 'STRUCT(family VARCHAR)[]'})
)
SELECT result.id, e_1.family
FROM transformed
CROSS JOIN UNNEST(result.e_1) AS f_1(e_1)
```

### Schema Generation

FlatQuack generates a `columns=` schema hint for `read_json_auto` via `pathsToSchema()`. This schema is **demand-driven** — it only includes fields that the ViewDefinition's FHIRPath expressions actually reference, not the full FHIR resource structure.

For a `forEach: "item"` on QuestionnaireResponse accessing `linkId` and `answer.valueString`, the generated schema is only one level deep:

```
{ id: 'VARCHAR', item: 'STRUCT(linkId VARCHAR, answer STRUCT(valueString VARCHAR)[])[]' }
```

### FHIR Schema and ContentReference

The FHIR schema (`schemas/fhir-schema-r4.json`) represents recursive structures using `ContentReference`:

```json
"QuestionnaireResponse.item.item":        {"t":"ContentReference","a":true,"cr":"QuestionnaireResponse.item"}
"QuestionnaireResponse.item.answer.item": {"t":"ContentReference","a":true,"cr":"QuestionnaireResponse.item"}
```

FlatQuack's `resolveType()` in `fhirpath-parser.js` already follows `cr` pointers, causing the `schemaPath` to loop back (e.g., `item.item` resolves back to `QuestionnaireResponse.item`). This works for single-level access but the system never unrolls the recursion.

## The Core Problem

FHIR defines `QuestionnaireResponse.item` as infinitely recursive, but DuckDB requires a **finite, statically-typed struct**. When `read_json_auto` infers the schema from data, the struct narrows at each depth level, with the deepest level lacking the recursive fields entirely:

| Depth | Struct type | Has `.item[]`? | Has `.answer[].item[]`? |
|-------|-------------|----------------|-------------------------|
| L0 (top-level) | Full struct | Yes | No (answer lacks `item`) |
| L1 (via `.item`) | Narrower | No | Yes |
| L2 (via `.answer[].item`) | Narrower still | No | No (answer is terminal) |

This **type narrowing** is the root of all implementation challenges.

## Solutions Investigated

### Solution A: `WITH RECURSIVE` CTE on Typed Structs

**Idea:** Use DuckDB's `WITH RECURSIVE` to traverse the nested structures, following both `item` and `answer.item` paths at each level.

```sql
WITH RECURSIVE all_items AS (
    SELECT id, unnest(item) AS node FROM source
    UNION ALL
    SELECT parent.id, unnest(parent.node.item) AS node
    FROM all_items parent
    WHERE parent.node.item IS NOT NULL
)
```

**Blocker:** DuckDB's `UNION ALL` in a recursive CTE requires uniform column types across branches. The `node` column changes struct type at each recursion level. Additionally, accessing `parent.node.item` fails at the deepest level where the struct lacks the `item` field — and this is a **binder error** (compile-time), not a runtime error.

**Additional constraint:** DuckDB only allows **one recursive reference** per CTE. Multiple `UNION ALL` branches each referencing the CTE (e.g., one for `item` path, one for `answer.item` path) are rejected as circular references.

**Verdict: Not viable** with typed structs.

### Solution B: `WITH RECURSIVE` CTE with JSON Cast

**Idea:** Cast nodes to `JSON` type at the CTE boundary, then use `json_extract` for navigation. JSON is dynamically typed — no struct narrowing, no binder errors for missing fields.

```sql
WITH RECURSIVE all_items AS (
    SELECT id AS _src_id, unnest(item)::JSON AS node FROM source
    UNION ALL
    SELECT parent._src_id, unnest(
        list_cat(
            coalesce(json_extract(parent.node, '$.item[*]')::JSON[], CAST([] AS JSON[])),
            coalesce(flatten(list_transform(
                coalesce(json_extract(parent.node, '$.answer[*]')::JSON[], CAST([] AS JSON[])),
                a -> coalesce(json_extract(a, '$.item[*]')::JSON[], CAST([] AS JSON[]))
            )), CAST([] AS JSON[]))
        )
    ) AS node FROM all_items parent
)
SELECT _src_id, node->>'linkId' AS link_id FROM all_items
```

**Verified working** with data nested 4+ levels deep.

| Pros | Cons |
|------|------|
| Truly recursive — handles arbitrary depth | Loses DuckDB's typed struct performance |
| No need to know data depth at compile time | Column extraction uses `json_extract` strings instead of struct field access |
| Single CTE handles any `repeat` path combination | Significant departure from FlatQuack's compilation model — all repeat columns need a different code generation path |
| Spec-compliant | Requires injecting CTEs before the `transformed` CTE, changing the SQL template structure |
| | DuckDB's `list_transform` lambda arrow syntax (`->`) is deprecated in newer DuckDB versions |

**Integration pattern:** The recursive CTE produces a flat table of `(_src_id, node_json)`. This can be JOINed to the main `transformed` CTE:

```sql
FROM transformed
JOIN repeat_items ri ON ri._src_id = result.id
```

This **does not fit** the existing `CROSS JOIN UNNEST` pattern — it replaces it with a regular JOIN. Repeat column expressions would use `ri.node->>'fieldName'` instead of struct access.

**Verdict: Viable** but requires a parallel code generation path for repeat blocks.

### Solution C: Compile-Time Unrolling with Chained CTEs

**Idea:** Since the struct type narrows at each level, generate a separate CTE per depth level, each accessing only the fields that exist in its static type. Union all levels at the end.

```sql
l0 AS (SELECT id, unnest(item) AS node FROM source),
l1 AS (SELECT id, unnest(node.item) AS node FROM l0 WHERE node.item IS NOT NULL),
l2 AS (SELECT id, unnest(a.item) AS node FROM l1, unnest(node.answer) AS t(a) WHERE a.item IS NOT NULL)
-- Union all
SELECT ... FROM l0 UNION ALL SELECT ... FROM l1 UNION ALL SELECT ... FROM l2
```

**Verified working** when the type-valid paths are followed correctly at each level.

| Pros | Cons |
|------|------|
| Uses typed structs — good performance | Requires knowing the struct depth at compile time |
| No JSON overhead | Each level may have different valid paths (at some levels `.item` exists, at others `.answer[].item` exists) — generation is complex |
| | Doesn't fit the existing two-phase pattern (needs multiple CTEs and UNION ALL) |
| | Depth-bounded by the inferred schema |

**Blocker for FlatQuack:** The struct depth is determined by `read_json_auto` at query time based on the actual data — **FlatQuack doesn't know it at compile time**. This approach only works if the schema is provided explicitly.

**Verdict: Viable only with explicit schema** (see Solution E).

### Solution D: Pure List Operations (`list_cat`/`flatten`/`list_transform`) on Auto-Inferred Schema

**Idea:** Collect all items at all depths into a single flat list using nested `list_cat` + `flatten` + `list_transform` calls in the SELECT expression, fitting the existing two-phase pattern exactly.

```sql
-- Phase 1: collect all items into a list
r_1: list_cat(
    item,                                                               -- depth 0
    coalesce(flatten(list_transform(item, i -> coalesce(i.item, []))), [])  -- depth 1
)
-- Phase 2: standard UNNEST
CROSS JOIN UNNEST(result.r_1) AS f_1(r_1)
```

**Blocker:** DuckDB's binder statically checks field access inside lambda expressions. When `i.answer` has type `STRUCT(valueString VARCHAR)` at one level (no `item` field), writing `a.item` inside a lambda is rejected as a **binder error** — even if guarded by `coalesce` or `WHERE`. `TRY()` does not help because it catches runtime errors, not binder errors.

Note: `list_cat` **does** widen struct types when combining lists of different struct shapes (filling missing fields with NULL). But you cannot *navigate into* a field that doesn't exist in the static type to get the data to combine.

**Verdict: Not viable** with auto-inferred schema (type narrowing causes binder errors).

### Solution E: Compile-Time Unrolling with Explicit Uniform Schema (Recommended)

**Idea:** Generate an explicit `columns=` schema where the recursive struct type is **unrolled to a fixed depth**, with every level including the recursive fields. Then use pure list operations (`list_cat`/`flatten`/`list_transform`) in the SELECT expression, fitting the existing two-phase pattern exactly.

The key insight: when `columns=` declares that `answer` has an `item` field at every level, the binder sees the field at all depths. DuckDB fills missing data with `null` at runtime, and `coalesce(..., [])` handles it cleanly.

```sql
-- Schema: uniform recursive type to depth N
-- Every level has both .item[] and .answer[].item[]
columns={
    id: 'VARCHAR',
    item: 'STRUCT(
        linkId VARCHAR, text VARCHAR,
        item STRUCT(
            linkId VARCHAR, text VARCHAR,
            item STRUCT(linkId VARCHAR, text VARCHAR, answer STRUCT(valueString VARCHAR)[])[], 
            answer STRUCT(valueString VARCHAR, 
                item STRUCT(linkId VARCHAR, text VARCHAR, answer STRUCT(valueString VARCHAR)[])[]
            )[]
        )[],
        answer STRUCT(valueString VARCHAR,
            item STRUCT(
                linkId VARCHAR, text VARCHAR,
                item STRUCT(linkId VARCHAR, text VARCHAR, answer STRUCT(valueString VARCHAR)[])[], 
                answer STRUCT(valueString VARCHAR, 
                    item STRUCT(linkId VARCHAR, text VARCHAR, answer STRUCT(valueString VARCHAR)[])[]
                )[]
            )[]
        )[]
    )[]'
}

-- SELECT: collect all items via list_cat (fits existing pattern)
r_1: list_cat(
    list_cat(
        item,
        coalesce(flatten(list_transform(item, i -> coalesce(i.item, []))), [])
    ),
    list_cat(
        coalesce(flatten(list_transform(item, i ->
            flatten(list_transform(coalesce(i.answer, []), a -> coalesce(a.item, [])))
        )), []),
        coalesce(flatten(list_transform(item, i ->
            flatten(list_transform(coalesce(i.item, []), i2 ->
                flatten(list_transform(coalesce(i2.answer, []), a -> coalesce(a.item, [])))
            ))
        )), [])
    )
)

-- FROM: standard CROSS JOIN UNNEST (identical to forEach)
CROSS JOIN UNNEST(result.r_1) AS f_1(r_1)
```

**Verified working** — all items at all depths returned correctly.

| Pros | Cons |
|------|------|
| Fits the existing two-phase pattern exactly | Depth-bounded (configurable, e.g., 5-10 levels) |
| Standard `CROSS JOIN UNNEST` — no template changes needed | Schema grows exponentially with depth (struct definition becomes large) |
| Typed struct access for columns — good performance | `list_cat`/`flatten`/`list_transform` expression tree grows with depth |
| FHIR schema already has `ContentReference` info to detect and unroll recursion | More complex `pathsToSchema` implementation |
| `columns=` schema is already generated by FlatQuack | |
| DuckDB fills missing nested data with `null` — `coalesce` handles it | |

**Implementation plan:**

1. **`view-parser.js`:** Add `repeat` validation (array of strings, mutually exclusive with `forEach`/`forEachOrNull`). In `parseNode()`, emit a new internal function (e.g., `_repeat(paths..., columns...)`) and register a table of type `"repeat"`.

2. **`ddb-sql-builder.js` / `pathsToSchema()`:** Detect `ContentReference` (`cr` field) during schema generation. When a `repeat` block is present, unroll the recursive type to a configurable depth N, ensuring every level includes the recursive fields. Generate the nested `list_cat`/`flatten`/`list_transform` expression tree for the `_repeat` case.

3. **`view-parser.js` / `extractPathsFromAst()`:** Extend path extraction to follow `ContentReference` loops to the configured depth, so `pathsToSchema` generates the full recursive struct.

4. **`query-builder.js` / Templates:** No changes needed — `repeat` produces a list column that gets UNNESTed via the existing `CROSS JOIN UNNEST` pattern.

5. **CLI:** Add a `--repeat-depth` parameter (default: 5 or 10) for edge cases.

**Verdict: Recommended approach.** Fits the existing architecture with minimal structural changes.

### Solution F: Chained CTE with Baked-In Context (JSON)

**Idea:** Instead of a global recursive CTE correlated back to the source via `_src_id` (Solution B), bake non-repeat columns and forEach context directly into the CTE's anchor member, then propagate them as scalars through the recursive member. The final SELECT reads directly from the CTE — no correlated subquery, no JOIN back to source.

This approach is inspired by the SQL Server inline table-valued function pattern (see `sof-mssql/docs/repeat-limitations.md`), adapted for DuckDB which lacks inline TVFs.

**Key insight:** The anchor member of the recursive CTE does the work that `_fq_source` + the correlated subquery currently do separately — it extracts resource-level columns, applies forEach unnesting, and enters the repeat traversal, all in one place. The recursive member only carries scalars and traverses deeper.

**Verified working** in DuckDB. Example for `repeat: ["item", "answer.item"]`:

```sql
WITH RECURSIVE repeat_0 AS (
    -- Anchor: extract non-repeat columns + unnest top-level items
    SELECT
        json_extract_string(r.resource, '$.id') AS resp_id,
        json_extract_string(r.resource, '$.status') AS status,
        unnest(coalesce(cast(r.resource->'item' AS JSON[]), []::JSON[])) AS node
    FROM fhir_data r

    UNION ALL

    -- Recursive: carry scalar columns, combine all repeat paths in one member
    SELECT resp_id, status,
        unnest(
            list_cat(
                coalesce(cast(node->'item' AS JSON[]), []::JSON[]),
                coalesce(flatten(list_transform(
                    coalesce(cast(node->'answer' AS JSON[]), []::JSON[]),
                    a -> coalesce(cast(a->'item' AS JSON[]), []::JSON[])
                )), []::JSON[])
            )
        ) AS node
    FROM repeat_0
)
SELECT
    resp_id, status,
    json_extract_string(node, '$.linkId') AS linkId
FROM repeat_0
```

**DuckDB-specific constraints verified:**

- `unnest` inside the recursive member: **works**.
- `list_transform` with lambdas inside the recursive member: **works**.
- Multiple `UNION ALL` branches each referencing the recursive CTE: **does not work** (same as Solution A). Multi-path repeat must combine all paths into a single recursive member via `list_cat`.

**forEach inside repeat** works naturally — the forEach's unnest moves to the final SELECT (or a lateral join on the CTE output):

```sql
-- forEach "answer" inside repeat ["item"]
SELECT
    resp_id,
    json_extract_string(node, '$.linkId') AS linkId,
    json_extract_string(ans, '$.valueString') AS answer_value
FROM repeat_0,
     unnest(coalesce(cast(node->'answer' AS JSON[]), []::JSON[])) AS t(ans)
```

**repeat inside forEach** also works — the forEach becomes an unnest in the anchor, scoping the repeat to each forEach element:

```sql
WITH RECURSIVE repeat_0 AS (
    -- Anchor: forEach baked in, repeat starts from forEach context
    SELECT
        json_extract_string(r.resource, '$.id') AS resp_id,
        json_extract_string(forEach_0, '$.linkId') AS groupLinkId,
        unnest(coalesce(cast(forEach_0->'item' AS JSON[]), []::JSON[])) AS node
    FROM fhir_data r,
         unnest(coalesce(cast(r.resource->'item' AS JSON[]), []::JSON[])) AS t(forEach_0)

    UNION ALL

    SELECT resp_id, groupLinkId,
        unnest(coalesce(cast(node->'item' AS JSON[]), []::JSON[])) AS node
    FROM repeat_0
)
SELECT resp_id, groupLinkId,
    json_extract_string(node, '$.linkId') AS linkId
FROM repeat_0
```

| Pros | Cons |
|------|------|
| No correlated subquery — final SELECT reads directly from the CTE | JSON traversal (same perf trade-off as Solution B) |
| forEach inside repeat works naturally (unnest in final SELECT) | Column propagation cost — non-repeat columns carried through every recursion level (cheap for typical FHIR depths) |
| repeat inside forEach works — forEach baked into anchor | Generator complexity — CTE builder must know about all non-repeat column expressions at construction time |
| No DDL, no JOIN back to source | Significant departure from FlatQuack's two-phase compilation model |
| Truly recursive — arbitrary depth | Single recursive member required (DuckDB constraint) — multi-path repeat needs `list_cat` |
| Solves limitations 1, 2, and 4 of Solution B's current implementation | |

**Verdict: Viable.** Addresses the main pain points of Solution B (correlated subquery, forEach/repeat nesting issues) while retaining arbitrary-depth recursion. The trade-off is increased generator complexity — the CTE construction must be aware of surrounding context (forEach, non-repeat columns), coupling concerns that are currently separate in FlatQuack's architecture.

### Solution G: Inline `WITH RECURSIVE` Inside the Value Expression (JSON)

**Idea:** Keep Solution B's JSON-based recursive traversal, but instead of hoisting the `WITH RECURSIVE` CTE to the top of the query, inline it *inside* the scalar subquery that produces the repeat column's list. Because it's an ordinary scalar subquery returning `list(struct)`, it composes anywhere a value expression composes — including inside `list_transform(el -> {...})` lambdas.

**Verified working** in DuckDB. Both `UNNEST((WITH RECURSIVE r AS (...) SELECT list(n) FROM r))` and a `WITH RECURSIVE` block inside a struct field correlated to the outer row work as expected. The outer `WITH` does **not** need the `RECURSIVE` keyword — recursion is carried by the inner subquery.

**Generated SQL structure** (top-level repeat — same shape as Solution B but with the CTE inlined):

```sql
WITH _fq_source AS (                        -- ← plain WITH; no template change
    SELECT * FROM read_json_auto('...', columns={id: 'VARCHAR', item: 'JSON[]'})
),
transformed AS (
    SELECT {
        id: id,
        e_1: coalesce((
            WITH RECURSIVE r AS (
                SELECT unnest(CAST(item AS JSON[])) AS node       -- ← seed correlates to outer row
                UNION ALL
                SELECT unnest(coalesce(CAST(node->'item' AS JSON[]), CAST([] AS JSON[])))
                FROM r
            )
            SELECT list({
                linkId: (json_transform(node, '{...}')).linkId,
                text:   (json_transform(node, '{...}')).text
            }) FROM r
        ), [])
    } AS result
    FROM _fq_source
)
SELECT result.id, e_1.linkId, e_1.text
FROM transformed
CROSS JOIN UNNEST(result.e_1) AS f_1(e_1);  -- ← unchanged flattener
```

**Why nested cases work naturally:**

The seed of the inline CTE evaluates in the surrounding scope — whether that's the source row or a `forEach` lambda iteration. There is no `_src_id` correlation key to propagate; each iteration's CTE simply seeds from whatever expression is in scope.

- **`repeat` inside `forEach`** — the seed reads from the lambda variable directly:
  ```sql
  entry.list_transform(el -> {
      e_2: coalesce((
          WITH RECURSIVE r AS (
              SELECT unnest(CAST((el.resource).item AS JSON[])) AS node    -- ← `el` in scope
              UNION ALL
              SELECT unnest(coalesce(CAST(node->'item' AS JSON[]), CAST([] AS JSON[]))) FROM r
          )
          SELECT list({linkId: (json_transform(node, '{...}')).linkId}) FROM r
      ), [])
  })
  ```
  No leakage of `el` into a top-level CTE — the CTE *is* in the lambda scope.

- **`repeat` inside `repeat`** — the inner CTE seeds from the outer recursion's `node`:
  ```sql
  -- inner CTE seeds from the outer _ri (typed via json_transform)
  SELECT list({...}) FROM (
      WITH RECURSIVE r2 AS (
          SELECT unnest(CAST(_ri.subItem AS JSON[])) AS node           -- ← outer _ri visible
          UNION ALL
          SELECT unnest(coalesce(CAST(node->'subItem' AS JSON[]), CAST([] AS JSON[]))) FROM r2
      )
      SELECT * FROM r2
  )
  ```

**Required generator changes:**

1. **`_repeat` in `ddb-sql-builder.js`:** emit a `(WITH RECURSIVE r AS (...) SELECT list(proj) FROM ...)` block instead of pushing the CTE to `_repeatCtes` and emitting a correlated `WHERE _src_id = id` subquery. The seed expression uses `__INPUT__` (already in flow — substituted by `flattenSql`) which now correctly resolves against the local scope (lambda var or outer column).
2. **`flattenSql`:** drop the `_repeatCtes` substitution path — `__INPUT__` only needs to be patched on the inline expression itself.
3. **`query-builder.js`:** drop `options._repeatCtes` accumulation and the `repeatCteSql` template variable.
4. **Templates:** `{{fq_sql_repeat_cte}}` slot becomes unused; `{{fq_sql_with}}` always resolves to `WITH`. Could be removed in a cleanup pass, or left as no-ops for backwards compatibility.
5. **Lambda variable handling:** the existing rename of `el → _ri` for column expressions inside the JSON-typed scope still applies (each repeat introduces its own `_ri`), but no longer crosses scopes — it's local to each `_repeat` emission.

**Performance trade-offs vs. Solution B (hoisted CTE):**

| Workload | Hoisted CTE (B) | Inline CTE (G) |
|----------|-----------------|----------------|
| 1000 resources, top-level repeat | One recursive walk over all rows + per-row filter | 1000 small recursive walks |
| 1000 resources, repeat inside forEach with avg 5 entries | ❌ Broken | 5000 very small recursive walks |
| Single resource (interactive query) | Fixed setup overhead | Lower setup, equivalent work |
| Wide schemas (parquet full FHIR) | JSON cast amortized once | JSON cast per iteration |

The hoisted form amortizes the recursive setup across all rows; the inline form trades that for compositionality. For the workloads where Solution B's `repeat-strategy=json` was specifically introduced (wide parquet schemas), the inline form may regress because each row pays its own JSON cast/setup cost — needs benchmarking.

| Pros | Cons |
|------|------|
| **Solves limitations 1, 2, and 3 of Solution B** without architectural change to flattener | Per-row recursive CTE setup overhead |
| Composes inside lambdas naturally — same scope rules as any value expression | Loses the "single shared walk" optimization for top-level repeats over large datasets |
| **No template changes needed** — `{{fq_sql_with}}` and `{{fq_sql_repeat_cte}}` become redundant | Generator emits more verbose SQL (CTE definition repeats per call site) |
| `__INPUT__` substitution stays simple — it's substituted only into the local expression | Performance vs. Solution B unverified for wide-schema workloads |
| Supports arbitrary nesting (`repeat` inside `forEach` inside `repeat`, etc.) | DuckDB's optimizer must handle nested `WITH RECURSIVE` per row |
| Outer `WITH` keyword unchanged — no `RECURSIVE` needed at top level | |
| No correlation key to maintain (`_src_id` filter goes away) | |

**Verdict: Viable, and the most compositional of the JSON-based options.** Recommended over Solution B if either (a) `repeat inside forEach` / `repeat inside repeat` are required, or (b) avoiding template surface area for the repeat feature is desirable. Should be benchmarked against Solution B on wide-schema parquet workloads before choosing as the default JSON strategy.

## Comparison Matrix

| Criterion | A: Recursive CTE (typed) | B: Recursive CTE (JSON, hoisted) | C: Chained CTEs | D: List ops (auto schema) | **E: List ops (explicit schema)** | F: Chained CTE (baked context) | G: Recursive CTE (JSON, inline) |
|-----------|--------------------------|----------------------------------|------------------|----------------------------|-------------------------------------|-------------------------------|---------------------------------|
| Fits existing pattern | No | No | No | Yes | **Yes** | No | **Yes** |
| Arbitrary depth | N/A | Yes | No | N/A | No (configurable limit) | Yes | Yes |
| Typed struct performance | N/A | No (JSON) | Yes | N/A | **Yes** | No (JSON) | No (JSON) |
| Template changes needed | N/A | Yes | Yes | No | **No** | Yes | **No** |
| Knows depth at compile time | N/A | Not needed | Required | N/A | **Generated to fixed depth** | Not needed | Not needed |
| Correlated subquery | N/A | Yes (perf cost) | No | N/A | No | **No** | No (CTE in scope) |
| forEach inside repeat | N/A | Broken (lambda shadowing) | N/A | N/A | **Works** | **Works** (unnest in final SELECT) | **Works** (CTE in lambda scope) |
| repeat inside forEach | N/A | Broken (CTE starts from root) | N/A | N/A | Not tested | **Works** (forEach baked into anchor) | **Works** (seed reads lambda var) |
| repeat inside repeat | N/A | Broken (no chaining) | N/A | N/A | Broken (single-pass unroll) | Possible (chained anchors) | **Works** (inner CTE seeds from outer node) |
| Per-row CTE setup cost | N/A | Amortized (one walk for all rows) | N/A | N/A | None | Amortized | Per row |
| Viable | **No** (binder error) | **Yes** (with limitations) | **Partially** | **No** (binder error) | **Yes** | **Yes** | **Yes** |

## Open Questions

1. **Default repeat depth:** What's a practical default? Real-world QuestionnaireResponses rarely exceed 5-6 levels. A default of 5 with a CLI override seems reasonable.

2. **Schema size:** The unrolled struct type grows exponentially with depth. At depth 5 with two repeat paths, the schema string could be quite large. Need to verify DuckDB handles very large `columns=` definitions without performance issues.

3. **Multiple repeat blocks:** The spec allows only one of `forEach`/`forEachOrNull`/`repeat` per select, but a ViewDefinition could have multiple select blocks each with their own `repeat`. Each would need its own unrolled schema and list expression.

4. **Interaction with `where`:** If a `where` clause references fields inside the recursive structure, `pathsToSchema` would also need to include those paths in the unrolled schema.

5. **Lambda syntax deprecation:** DuckDB is deprecating the `->` lambda arrow in favour of a new syntax. FlatQuack already uses `->` extensively — this is a broader issue not specific to `repeat`.
