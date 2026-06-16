# Spec D — Hybrid: staged chains + lazy fork keys (BEST MEASURED)

Translate a SQL-on-FHIR **ViewDefinition** into DuckDB SQL that combines the two
fast lowerings:

- **Spec C's staged `UNNEST`** as the substrate for every *chain* — materialise a
  child array as a column, `UNNEST` that column in the next stage, carry scalars
  forward. No keys, no joins.
- **Spec B's keyed recombination** *only at independent fan-out forks* — where a
  `select` has ≥2 children that each fan out, compute each branch once as its own
  staged chain and recombine by a `JOIN` on the **fork scope's key**. The key is
  generated **lazily**: only on the spine that reaches a fork, only as deep as the
  fork. At the **root** fork the key is just the resource key (a scalar);
  at a **nested** fork it is the resource key extended by the local ordinals taken
  to reach the fork.

The defining idea: **chain when you can, key only at forks, and pick the cheapest
key the fork's depth allows.** No siblings ⇒ no keys ⇒ no joins (it degrades to
Spec C). A root fork ⇒ a scalar resource-key join (Spec C's `json_keyjoin`). A
nested fork ⇒ a small composite scalar key.

> **Why this is the best measured.** Two orthogonal factors — *representation*
> (typed vs JSON) and *strategy* (keyed vs structural) — compound. Holding the JSON
> binding fixed (QuestionnaireResponse, 692 MB, DuckDB 1.4.1/1.5.2,
> `preserve_insertion_order=false`):
> - **nested fork** (`forEach item` → two `forEachOrNull answer.item`, 3.125M rows):
>   Spec D **2.5 s**; Spec B streaming (LIST path-id key) 7.1 s; Spec A / keyless
>   correlated cross-`UNNEST` 13–60 s; Spec C carry-forward re-expansion is the same
>   13–60 s family.
> - **root fork** (two `forEach item` siblings, 15.625M rows): Spec D **3.0 s**; the
>   structural typed baseline 4.6 s.
> - On a **typed** binding (permitted, §2) Spec D is **0.5 s** (nested) / **0.6 s**
>   (root) — fastest of every variant in both topologies.
> The win over Spec B is the scalar key (vs `LIST` equality); the win over Spec A/C
> at forks is computing each branch once (a hash join replays a *scalar* branch)
> instead of re-expanding JSON per outer row.

Working reference queries this spec generalizes (in `benchmark/work/`):
`nested_json_staged.sql` / `nested_comma_staged.sql` (chain substrate, Spec C),
`sibling_json_keyjoin.sql` (root fork, resource-key join),
`nested_sibling_hybrid.sql` (nested fork, composite-key join),
`repeat_lateral_rcte.sql` (chain `repeat`).

---

## 1. Input model & semantics

Identical to Spec A §1 (normalized ViewDefinition; `row_product` per-parent
Cartesian semantics; `column`=×1, `forEach`/`repeat`=×0..N, `forEachOrNull`=×1..N;
`repeat` excludes the seed and emits all descendants; `collection=true` keeps the
JSON array). Read it first.

---

## 2. Source CTE & FHIRPath leaf translation

**Self-contained — do not consult another spec.** This is the same JSON binding as
Specs B and C: the `LIST`/`SCALAR`/`BOOL` interface over `read_ndjson_objects`.

> **The leaf binding is a NON-NORMATIVE interface.** The normative part of Spec D is
> the *structural* decision (chain vs fork) and the *keying* (§3–§7). Those depend on
> FHIRPath leaves only through three pure functions — `LIST(node,path) → JSON[]`,
> `SCALAR(node,path,type) → value`, `BOOL(node,path) → boolean`. An implementation is
> free to honour that interface any way it likes — a real FHIRPath engine, the
> flatquack AST→SQL compiler, or **typed columns** (`read_json_auto` with a `STRUCT`
> schema). The JSON mapping below is given in full so the spec is self-contained and
> machine-checkable; a typed binding conforms and is **measurably faster** (§intro).

The `fhir_list` macro (one argument; handles FHIR's single-value-vs-array ambiguity):

```sql
CREATE OR REPLACE MACRO fhir_list(j) AS (
  CASE WHEN j IS NULL THEN CAST([] AS JSON[])
       WHEN json_type(j)='ARRAY' THEN CAST(j AS JSON[])
       ELSE CAST([j] AS JSON[]) END
);
```

> **`LIST(...)`, `SCALAR(...)`, `BOOL(...)` are meta-notation, not SQL.** Expand each
> inline to the SQL below. Never emit a literal `LIST(...)` call — DuckDB's `LIST` is
> an aggregate and would collapse the collection.

**(a) `LIST(node, path) → JSON[]`.** FHIRPath navigation **flattens at every step**:
`a.b` = "for each element of `a`, take `b`, concatenated". Build by folding
`fhir_list` over the dot steps; **never** collapse a multi-step path to one JSON path
like `'$.a.b'` (it does not traverse an array intermediate → silent NULL), and
**never** index with `[0]`/`[*]` unless the FHIRPath says so (`.first()` ⇒ `[1]`):

- `$this`               ⇒ `fhir_list(node)`
- single step `a`       ⇒ `fhir_list(node -> '$.a')`
- each further step `b` ⇒ `list_transform(<prev>, x -> fhir_list(x -> '$.b')).flatten()`

So `a.b.c` is `list_transform(list_transform(fhir_list(node -> '$.a'), x -> fhir_list(x -> '$.b')).flatten(), x -> fhir_list(x -> '$.c')).flatten()`.
`ofType(X)` ⇒ the typed field (`value.ofType(string)` ⇒ step `valueString`).
**Indexer `[k]`** (0-based) slices the *flattened* collection so far:
`(LIST(node, prefix))[k+1:k+1]`. `where(pred)` ⇒ `list_filter(<listSoFar>, x -> BOOL(x, pred))`.

**(b) `SCALAR(node, path, type) → value`.** A `column` is **scalar unless
`collection:true`** — always emit one value (empty ⇒ `NULL`, never `[]`):

- literal path (`'item'`, `1`) ⇒ the literal, cast to T
- `$this`         ⇒ `CAST(node ->> '$' AS T)`
- single step `a` ⇒ `CAST(node ->> '$.a' AS T)`
- dotted `a.b.…`  ⇒ `CAST(LIST(node, path)[1] ->> '$' AS T)`
- `getResourceKey()` ⇒ `node ->> '$.resourceType' || '/' || node ->> '$.id'`;
  `getReferenceKey([X])` ⇒ parse `node ->> '$.reference'`.

> **Always read a scalar leaf with `->> '$'` (or `->> '$.path'`), never `CAST(node
> AS VARCHAR)`.** `->>` is the JSON **text** accessor — it unwraps a JSON string to
> its raw text. `CAST(json AS VARCHAR)` keeps the JSON encoding, so a string element
> comes back **double-quoted** (`"N2"` instead of `N2`) — the most common scalar bug.
> This applies especially to `$this` over a primitive element (e.g. a `forEach
> name.given` whose elements are JSON strings): write `CAST(node ->> '$' AS T)`, not
> `CAST(node AS T)`.

**(c) `BOOL(node, path) → boolean`** — a `where` predicate; must yield `BOOLEAN`.

`sqlType`: `id|string|code|uri→VARCHAR`, `integer→BIGINT`, `decimal→DOUBLE`,
`boolean→BOOLEAN`, `dateTime|date|instant→VARCHAR`. A collection column
(`collection:true`) keeps the whole `LIST(node,path)` as a JSON array.

**Materialising a child array for the next stage** uses the same fold:
`LIST(node, childPath)`. The `CAST(node -> '$.child[*]' AS JSON[])` shortcut is valid
**only** when `child` is always a JSON array; prefer the `fhir_list` fold by default.

---

## 3. Two inherited disciplines + one decision

Spec D obeys the two non-negotiable disciplines that make B and C fast, and adds one
classification step.

**Discipline 1 — materialise-then-`UNNEST` (from Spec C).** Never `UNNEST` a
correlated path expression (`UNNEST(CAST(parent.node -> '$.x[*]' AS JSON[]))` — the
Spec A shape decorrelates into a `DELIM_JOIN` cascade). **Always** materialise the
child array as a *named column* in the parent stage, then `UNNEST` that column. The
`UNNEST` target is then a plain column of the driving row — set-based, no delim join.

**Discipline 2 — never carry JSON nodes through a fan-out (from B/C).** Project
scalars at the stage that owns them; carry only scalars + the arrays still needed
downstream. Carrying a multi-KB `node` blob across a fan-out duplicates it per
produced row (measured OOM / 13–60 s).

**The decision — chain vs fork (the new part).** At every `select` scope, count its
**fan-out children** (`forEach`/`forEachOrNull`/`repeat`; a `unionAll` whose branches
fan out counts too):

| fan-out children of the scope | mode | mechanism |
|---|---|---|
| **0 or 1** (a *chain*) | **CHAIN** | Spec C carry-forward staging — no key, no join |
| **≥2** (an independent fan-out *fork*) | **FORK** | Spec B keyed recombination — each branch computed once, joined on the scope key |

A view with no fork anywhere lowers to **pure Spec C** (no keys at all). Keys appear
**only** on spines that reach a fork.

---

## 4. The fork key (lazy, scope-scoped, scalar)

The recombination key at a fork is the **fork scope's context key**: the resource key,
extended by the **1-based ordinal of each iterating step** on the spine from the root
(or the nearest enclosing fork) down to the fork scope.

```
resource #r                        key = (r)
  forEach item   #i                key = (r, i)
  forEach item #i → forEach x #j   key = (r, i, j)
```

Represent the key as **separate scalar columns** `(rid, ord_1, …, ord_k)` — this is
the scalar-decomposed form of Spec B's `LIST` path-id, and it **equi-joins ~2.8×
faster than `LIST` equality** (measured: 2.5 s vs 7.1 s on the nested fork). A Spec B
`LIST` path-id `id = [r, i, …]` is an equivalent, depth-agnostic alternative; prefer
the scalar columns for performance.

Generating the key lazily:
- `rid` — the resource key. Emit **once** in `src`: `row_number() OVER ()` (a scalar),
  or any natural/file key, or the resource's own `id` when a fork is at the root.
- `ord_i` — the local subscript at the *i*-th iterating step on the spine to a fork.
  Emit it **only** at iterating stages that lead to a fork, via DuckDB's positional
  zip — `generate_subscripts(arr, 1)` next to `unnest(arr)` in a SELECT, or
  `UNNEST(col) WITH ORDINALITY`. A chain that reaches no fork emits **no** ordinal.

At a **root** fork the key is just `rid` (a scalar resource key — Spec C's
`json_keyjoin`). At a **nested** fork it is `(rid, ord_1, …)`. The branches of a fork
each carry the same key columns and recombine by `JOIN … USING (rid, ord_1, …)`.

---

## 5. Per-operator templates

### Source / root scope
```sql
WITH src AS (
  SELECT row_number() OVER () AS rid,          -- resource key (scalar); omit if no fork needs it
         json(json) AS node
  FROM read_ndjson_objects('{FILE}')
  WHERE node ->> '$.resourceType' = '{vd.resource}'   -- if vd.resource set
)
```
`roots` then projects root-scope scalar columns and materialises the root child
arrays as columns (one per root fan-out child), exactly as Spec C §4.

### column  (folds into the owning stage — never a CTE)
```sql
SCALAR(node, c.path, c.type) AS {c.name}    -- scalar
LIST(node, c.path)           AS {c.name}    -- collection (c.collection=true)
```

### CHAIN mode — forEach / forEachOrNull (Spec C staged column `UNNEST`)
Parent stage materialises `{arr}` (pad to `[NULL]` for `forEachOrNull`); child stage
`UNNEST`s the **column**:
```sql
s_{n} AS (
  SELECT {carried scalars...},
         SCALAR(node,'{col.path}','{col.type}') AS {col.name},
         LIST(node,'{childPath}')               AS {next_arr}   -- materialise next level
  FROM {parent} [, | LEFT JOIN] UNNEST({parent}.{arr}) AS _u(node) [ON TRUE]
)
```
`, UNNEST(col)` = `forEach` (INNER); `LEFT JOIN UNNEST(col) ON TRUE` over a `[NULL]`-
padded column = `forEachOrNull`. No key is carried in a pure chain.

### FORK mode — the keyed spine + branch recombination (Spec B)
At a fork scope on driving stage `P` (which carries the key columns `K = rid[,ord…]`
and a materialised array per branch), emit **each fan-out branch as its own staged
chain** that carries `K` and reduces to scalar columns, then recombine:

```sql
-- branch a: a Spec C chain off P, carrying K, materialised-column UNNEST throughout
a AS ( SELECT {K}, {a's scalar columns} FROM P [LEFT JOIN] UNNEST(P.a_arr) AS _a(node) [ON TRUE] /* …further chain… */ ),
b AS ( SELECT {K}, {b's scalar columns} FROM P [LEFT JOIN] UNNEST(P.b_arr) AS _b(node) [ON TRUE] /* … */ )
-- recombine on the fork key; INNER for forEach/repeat/unionAll, LEFT for forEachOrNull
SELECT base.{fork-scope columns}, a.*, b.*
FROM {base keyed by K} 
JOIN a USING ({K})          -- or LEFT JOIN … USING({K}) if branch a is forEachOrNull
JOIN b USING ({K})
```
Each branch is computed **once**; the join replays scalar rows (cheap), never
re-expands JSON. If a branch is itself a fork, recurse (it gets its own deeper key).

### repeat
**A `repeat` descends *only* the listed `repeat` paths**, recursively, excluding the
seed. **Never** walk all `json_keys` — descend `LIST(node, p1)` (∪ `list_cat` the
other listed paths). Three mandatory mechanics:
1. The descent CTE **must** live under a leading **`WITH RECURSIVE`** — a recursive
   CTE under a plain `WITH` is a `Catalog Error: Table 'rep' does not exist`.
2. Inside a `list_transform`, write the lambda as `lambda x:` (not `x ->`) so the
   body's JSON arrow `x -> '$.path'` is unambiguous (else `Binder Error: invalid
   lambda parameters`).
3. **A lone `repeat` (the single fan-out child of its scope) is a CHAIN — no key, no
   join.** Carry the scope's scalars *into and through* the recursive CTE; do **not**
   mint a `fork_key`/`row_number`, and do **not** zip `generate_subscripts` next to a
   `LEFT JOIN UNNEST` (they cross-multiply). Only key a `repeat` when it is one of
   **≥2** fan-out siblings (a fork).

- **In a chain** (lone `repeat`): a streaming `WITH RECURSIVE` CTE that carries the
  scope's scalars; recurse into `child.select` on its `node`. Equivalent: Spec C
  `LATERAL (WITH RECURSIVE …)` over the materialised seed column (~1 s, 1.4≈1.5).
  ```sql
  WITH RECURSIVE
  rep AS (
    SELECT {carried scalars}, _s.node AS node                     -- base: seed elements (materialised col)
    FROM {parent}, UNNEST({parent}.seed_arr) AS _s(node)
    UNION ALL
    SELECT {carried scalars}, _c.node AS node                     -- recurse: listed paths only
    FROM rep, UNNEST(fhir_list(rep.node -> '$.{p1}')) AS _c(node)  -- (list_cat extra paths)
  )
  ```
- **At a fork** (a `repeat` beside another fan-out — `repeat` branches are *always*
  independent fan-outs): emit it as the streaming descent above but **carry the fork
  key** and a per-descent path, `list_append(path, generate_subscripts(children,1))`;
  key the inner scope by `(forkKey, path)` and join it to its siblings on the fork key.

### unionAll
Non-iterating. In a chain, `UNION ALL` of branch pipelines (identical columns). At a
fork scope, each branch is keyed by the fork scope key (Spec B §4 `R0` re-key) and
joins like any other child on that key.

### where / resource
`WHERE BOOL(node,path)` / `WHERE node ->> '$.resourceType' = 'X'` on the stage whose
`node` the predicate references (root filters on `roots`).

---

## 6. Scope composition (the algorithm)

```
emitScope(selectNode, parentStage, ctxArrCol, key):
  # key = the carried key columns (rid[,ord…]); empty until a fork is reached
  cols     = column projections of this level (SCALAR/LIST(node,·))   # fold into the stage
  forks    = row-producing children of selectNode
  thisStage = CTE: SELECT {carried scalars}, cols,
                          (materialise one array column per fan-out child),
                          (if this scope is a fork: also expose key columns)
                   FROM parentStage [, | LEFT JOIN] UNNEST(ctxArrCol) [ON TRUE]   -- or src/LATERAL(rCTE)

  if |forks| <= 1:                                  # CHAIN
     for the (≤1) fan-out child: emitScope(child.select, thisStage, thisStage.<arr>, key)   # no new key
     # columns of a chain just accumulate down the lineage; no join

  else:                                             # FORK
     forkKey = key extended with this spine's ordinals down to thisStage
               (root fork ⇒ forkKey = (rid); nested fork ⇒ (rid, ord_1, …))
     branchRels = []
     for child in forks:
        # each branch is its own staged chain, carrying forkKey, reduced to scalars
        branchRels += (joinKind(child), emitBranch(child, thisStage, forkKey))
     base = SELECT forkKey, cols FROM thisStage
     result = base
     for (INNER, br) in branchRels: result = result JOIN      br USING (forkKey)
     for (LEFT,  br) in branchRels: result = result LEFT JOIN br USING (forkKey)
     return SELECT base.cols + every branch's cols FROM result      # forkKey is internal
```

- `joinKind`: `forEach`/`repeat`/`unionAll` ⇒ INNER (empty kills the row);
  `forEachOrNull` ⇒ LEFT (empty ⇒ one NULL row).
- **Columns at the fork scope fold into `base`** (no join), exactly as in a chain.
- **Generate `ord_i` only on a spine that reaches a fork.** A subtree with no fork
  below it never produces an ordinal and is pure carry-forward.
- **Projection contract.** The final `SELECT` outputs **exactly** the VD's columns by
  `name`, in tree order — nothing else. `rid`/`ord_*` (or a `LIST` path-id) are
  internal key bookkeeping: they thread through CTEs but **never** appear in the
  result and never overwrite a VD column. (A VD `column` named `id` is the FHIR `id`
  via `SCALAR(node,'id',…)` — unrelated to `rid`.)
  - **Enforced by an `_` prefix, not by convention.** A VD column name is a validated
    SQL identifier matching `^[A-Za-z][A-Za-z0-9_]*$` (it must start with a letter), so
    every internal identifier the emitter mints — the key (`_rid`), fork ordinals
    (`_ord{N}`), a repeat's descent columns (`_node`, `_ord`, `_path`), its pre-order
    index (`_nord{N}`), and all generated relation/column names — is `_`-prefixed and
    therefore *cannot* collide with any legal VD column name, even one literally named
    `rid`, `node`, or `path`. Without this, such a column would surface as a duplicate
    column in a CTE (a hard binder error, or silent value loss in `uuid` mode).

---

## 7. Worked example — chain (pure Spec C, no key)

`forEach item` → `forEachOrNull answer.item` → `forEachOrNull answer.item` (one
fan-out child per level ⇒ all CHAIN, no fork, no key). Identical to Spec C §7:

```sql
WITH
  src AS (SELECT r ->> '$.id' AS response_id,
                 coalesce(CAST(r -> '$.item[*]' AS JSON[]), CAST([] AS JSON[])) AS items
          FROM read_ndjson_objects('{FILE}') t(r)),
  l1 AS (SELECT response_id, item ->> '$.linkId' AS l1_link_id,
                ifnull(CAST(item -> '$.answer[*].item[*]' AS JSON[]), CAST([NULL] AS JSON[])) AS l2_items
         FROM src CROSS JOIN UNNEST(items) AS _i(item)),
  l2 AS (SELECT response_id, l1_link_id, l2 ->> '$.linkId' AS l2_link_id,
                ifnull(CAST(l2 -> '$.answer[*].item[*]' AS JSON[]), CAST([NULL] AS JSON[])) AS l3_items
         FROM l1 LEFT JOIN UNNEST(l2_items) AS _j(l2) ON TRUE)
SELECT response_id, l1_link_id, l2_link_id, l3 ->> '$.linkId' AS l3_link_id
FROM l2 LEFT JOIN UNNEST(l3_items) AS _k(l3) ON TRUE;
```

## 8. Worked example — root fork (resource-key join)

Two `forEach item` siblings at the root, each `item → forEachOrNull answer.item`. The
fork is at the **resource**, so the key is the scalar resource key; each branch is a
Spec C chain joined on it (this is `sibling_json_keyjoin.sql`):

```sql
WITH
  src AS (SELECT r ->> '$.id' AS response_id,
                 coalesce(CAST(r -> '$.item[*]' AS JSON[]), CAST([] AS JSON[])) AS items
          FROM read_ndjson_objects('{FILE}') t(r)),
  a1 AS (SELECT response_id, a_item ->> '$.linkId' AS a_link_id,
                ifnull(CAST(a_item -> '$.answer[*].item[*]' AS JSON[]), CAST([NULL] AS JSON[])) AS a_sub
         FROM src CROSS JOIN UNNEST(items) AS _a(a_item)),
  a  AS (SELECT response_id, a_link_id, s ->> '$.linkId' AS a_sub_link_id
         FROM a1 LEFT JOIN UNNEST(a_sub) AS _t(s) ON TRUE),
  b1 AS (SELECT response_id, b_item ->> '$.linkId' AS b_link_id,
                ifnull(CAST(b_item -> '$.answer[*].item[*]' AS JSON[]), CAST([NULL] AS JSON[])) AS b_sub
         FROM src CROSS JOIN UNNEST(items) AS _b(b_item)),
  b  AS (SELECT response_id, b_link_id, s ->> '$.linkId' AS b_sub_link_id
         FROM b1 LEFT JOIN UNNEST(b_sub) AS _t(s) ON TRUE)
SELECT a.response_id, a.a_link_id, a.a_sub_link_id, b.b_link_id, b.b_sub_link_id
FROM a JOIN b USING (response_id);
```

## 9. Worked example — nested fork (composite scalar key)

`forEach item` → two `forEachOrNull answer.item` siblings. The fork is at the **item**
scope, so the key is `(rid, item_ord)`. The spine mints `rid` at `src` and `item_ord`
at the `forEach item` stage; each branch `UNNEST`s a **materialised** column and is
recombined on the composite key (this is `nested_sibling_hybrid.sql`):

```sql
WITH
  src AS (SELECT row_number() OVER () AS rid, r ->> '$.id' AS response_id, r AS node
          FROM read_ndjson_objects('{FILE}') t(r)),
  item AS (                                   -- forEach item spine: mint item_ord, materialise sub-arrays
    SELECT s.rid, s.response_id, g.item_ord,
           g.it ->> '$.linkId' AS item_link_id,
           ifnull(CAST(g.it -> '$.answer[*].item[*]' AS JSON[]), CAST([NULL] AS JSON[])) AS sub_arr
    FROM src s, UNNEST(coalesce(CAST(s.node -> '$.item[*]' AS JSON[]), CAST([] AS JSON[])))
                  WITH ORDINALITY AS g(it, item_ord)),
  a AS (SELECT rid, item_ord, response_id, item_link_id, sub ->> '$.linkId' AS a_sub_link_id
        FROM item LEFT JOIN UNNEST(sub_arr) AS _a(sub) ON TRUE),     -- materialised column UNNEST
  b AS (SELECT rid, item_ord, sub ->> '$.linkId' AS b_sub_link_id
        FROM item LEFT JOIN UNNEST(sub_arr) AS _b(sub) ON TRUE)
SELECT a.response_id, a.item_link_id, a.a_sub_link_id, b.b_sub_link_id
FROM a JOIN b USING (rid, item_ord);          -- composite scalar key (faster than a LIST path-id)
```

(The negative control: joining on the resource key alone here is **wrong** — it
cross-products every item's A-subrows with every item's B-subrows in the same
resource. A nested fork's key must include the item ordinal.)

---

## 10. Worked example — repeat (chain, no key)

Root → `repeat item` → `{ column linkId, forEach answer → answerValue }`. The root
has one fan-out child (the `repeat`) ⇒ CHAIN; the repeat scope has one fan-out child
(the `forEach`) ⇒ CHAIN. **No fork, no key** anywhere — the `id` carries through the
`WITH RECURSIVE` descent, the `forEach answer` chains off each visited node:

```sql
WITH RECURSIVE
  src   AS (SELECT json(json) AS node FROM read_ndjson_objects('{FILE}')
            WHERE node ->> '$.resourceType' = 'QuestionnaireResponse'),
  roots AS (SELECT node ->> '$.id' AS id, fhir_list(node -> '$.item') AS seed FROM src),
  rep   AS (                                   -- repeat item: lone fan-out child ⇒ CHAIN, carry id
    SELECT id, _s.node AS node FROM roots, UNNEST(seed) AS _s(node)
    UNION ALL
    SELECT id, _c.node AS node FROM rep, UNNEST(fhir_list(rep.node -> '$.item')) AS _c(node)),
  item  AS (SELECT id, node ->> '$.linkId' AS linkId,
                   fhir_list(node -> '$.answer') AS answers FROM rep)
SELECT id, linkId,
       CAST(_a.node ->> '$.valueString' AS VARCHAR) AS answerValue   -- value.ofType(string) ⇒ valueString
FROM item, UNNEST(answers) AS _a(node);                             -- forEach answer (chain, INNER)
```

For a `repeat` that is one of **≥2** fan-out siblings, switch that scope to FORK mode
(§5 repeat): carry the fork key + a descent path through the `WITH RECURSIVE`, and
join the repeat's scope to its siblings on the fork key.

## 11. `%rowIndex` (positional index for forEach / repeat)

`%rowIndex` is the **0-based positional index of an element within the collection
its operator iterates, scoped to that operator's parent instance** — *not* a global
`ROW_NUMBER() OVER` over the output (SoF is order-agnostic; the index is structural,
computed at the unnest/descent step, so it survives `preserve_insertion_order=false`).

The hybrid is already positioned for this: `%rowIndex` **is** the
`generate_subscripts`/`WITH ORDINALITY` ordinal it mints for fork keys (§4) — just
surfaced as a column value (minus 1, since the ordinal is 1-based) instead of (or
alongside) being used in a key.

### forEach / forEachOrNull
The element's ordinal, available in **either** mode at zero extra cost. The ordinal is
**1-based**, so `%rowIndex = ord - 1`:

```sql
-- CHAIN mode (staged column UNNEST): add WITH ORDINALITY
FROM {parent}, UNNEST({parent}.arr) WITH ORDINALITY AS t(node, ord)       -- %rowIndex = ord - 1

-- FORK / unnest-in-SELECT mode: generate_subscripts zips positionally with unnest (already 1-based)
SELECT generate_subscripts(arr, 1) AS ord, unnest(arr) AS node FROM {parent}
```

`ord` is `1,2,3…` **per parent row** (it resets automatically — each driving row's
`arr` starts at 1), so `%rowIndex` is `0,1,2…`. For `forEachOrNull`'s empty→NULL row,
`%rowIndex` is **0**: a `LEFT JOIN UNNEST` yields no ordinal (`NULL`) for the empty
collection, so coalesce before subtracting — `COALESCE(ord, 1) - 1` = `0`. Identical on
`JSON[]` and `STRUCT[]`.

### repeat
A `repeat` has no single parent collection, so the index is assigned **at the repeat
scope** via a window ordered by the descent **path** (the int list of per-level
subscripts the scope already carries, §5 repeat). Two rules make it correct and cheap:

1. **Assign at the repeat's own scope** (one row per visited node), **before** the
   scope is recombined with any sibling — then carry the scalar through the join.
   Computing `ROW_NUMBER()` on the *final flattened output* is wrong: a sibling
   cross-product would multiply the rows and inflate the index.
2. **Partition by the repeat's parent-scope instance**, order by its path
   (`ROW_NUMBER()` is 1-based, so `%rowIndex = rn - 1`):

   ```sql
   ROW_NUMBER() OVER (PARTITION BY {parent-scope key} ORDER BY path) - 1 AS rn
   ```
   - **root** repeat → parent scope is the resource → `PARTITION BY rid`
   - **nested** repeat → parent scope is the enclosing iterating node → partition by
     that scope's key `(rid, ord₁…ordₖ)`.

   **Use the enclosing scope's own scalar `%rowIndex` as the partition surrogate.**
   A repeat-inside-repeat keys the inner index by `(rid, outer_rn)` — so nested
   repeats *chain* their indices and you never `PARTITION BY` a `LIST`:
   ```sql
   o_idx AS (   -- outer repeat: rn per resource (0-based); also each ancestor's scalar id
     SELECT …, ROW_NUMBER() OVER (PARTITION BY rid ORDER BY opath) - 1 AS outer_rn FROM o),
   …
   -- inner repeat, carrying outer_rn; its index resets per ancestor:
   SELECT …, ROW_NUMBER() OVER (PARTITION BY rid, outer_rn ORDER BY ipath) - 1 AS inner_rn FROM i
   ```

Order by the **int list** path, never a string path (`'1.2.1'` mis-orders at ≥10
siblings; an `int[]` orders element-wise numerically). Two more scalars come free
from the path if wanted: **depth** = `len(path)`, **local sibling index** = `path[-1]`.

### Cost
Effectively **free** (measured, `repeat_view` / `nested_repeat_view` on qr_100/qr_1000;
see `benchmark/hybrid_vs_baseline.md`): the path is **carried, not joined** (a tiny
`BIGINT[]`, no `LIST`-equality joins), and the window is a sort dwarfed by the
recursion + JSON parse that dominate a `repeat`. Adding the index showed **no
penalty** (even a slight speedup, from the better-planning `unnest()`-in-SELECT
recursion form). The real `repeat` cost to avoid is the **typed** binding (§13), not
the index.

## 12. Directive cheat-sheet

| VD directive          | CHAIN scope (≤1 fan-out)                              | FORK scope (≥2 fan-out)                                   |
|-----------------------|-------------------------------------------------------|-----------------------------------------------------------|
| `column` (scalar/coll)| `SCALAR/LIST(node,path) AS name`, fold into the stage | same; folds into the fork `base`                          |
| `forEach`             | `, UNNEST(parent.arr) AS a(node)` (materialised col)  | branch chain carrying key; recombine `JOIN USING(key)`    |
| `forEachOrNull`       | `LEFT JOIN UNNEST(parent.arr_[NULL]) ON TRUE`         | branch chain; recombine `LEFT JOIN USING(key)`            |
| `repeat`              | `LATERAL (WITH RECURSIVE …)` over a materialised seed | streaming descent + path id; `JOIN USING(rid,path)`       |
| `unionAll`            | `UNION ALL` of branch pipelines                       | branches keyed by fork key; `JOIN USING(key)`             |
| `where` / `resource`  | `WHERE BOOL/resourceType` on the stage                | same                                                      |
| key (`rid`,`ord_i`)   | **none** (no key in a chain)                          | `rid` at `src`; `ord_i` via `generate_subscripts`/`WITH ORDINALITY` on the spine |
| `%rowIndex` (§11)     | forEach: `WITH ORDINALITY`/`generate_subscripts` ordinal `- 1` (0-based); repeat: `ROW_NUMBER() OVER (PARTITION BY parent-scope key ORDER BY path) - 1` | same (assign at the operator's scope, carry the scalar through joins) |

---

## 13. Edge cases & notes

- **Lazy keys, literally.** Walk the tree first; mark fork scopes (≥2 fan-out
  children). Emit `rid`/`ord_i` **only** on spines from root to a fork. A view with no
  fork is pure Spec C (no `row_number`, no ordinals, no joins).
- **Scalar key vs `LIST` path-id.** Prefer scalar columns `(rid, ord_1, …)` — `USING`
  equi-join on integers is ~2.8× faster than Spec B's `LIST` equality (measured). The
  `LIST` form is equivalent and depth-agnostic; use it if generating distinct ordinal
  columns per level is awkward.
- **Materialise before `UNNEST`, always** (Spec C §3). Even inside a fork branch,
  `UNNEST` a column, not `UNNEST(CAST(node -> path …))` — one correlated level is
  tolerable, stacked levels decorrelate into the Spec A delim-join cascade.
- **Never carry JSON nodes through a fan-out** (B/C). Reduce each branch to scalars
  *before* the recombination join; that is exactly why the join is cheap.
- **`forEachOrNull`** = `[NULL]`-padded materialised column + `LEFT JOIN UNNEST … ON
  TRUE` (chain), or a `LEFT JOIN USING(key)` branch (fork). A streaming `unnest` of an
  empty list yields 0 rows — the `[NULL]` pad / LEFT join supplies the required NULL row.
- **Shallow shared-array siblings** (≥2 `forEach` off one parent, *none* fanning out
  further) may be left as a CHAIN (parallel `, UNNEST(col)` entries, Spec C §5) — the
  cross product is small and re-expansion is negligible, so the key+join overhead is
  not worth it. Promote to FORK only when a branch fans out further.
- **Single-vs-array fields**: use `fhir_list` for any 0..1 field; the `[*]` shortcut
  is for true arrays only.
- **`column` collection guard**: a scalar column whose path yields >1 value errors in
  the reference — rely on validation or a `len(...)<=1` guard.
- **`preserve_insertion_order = false`** before the query (Spec C §10): recovers
  parallel result materialisation (DuckDB 1.5 serialises order-preserving sinks;
  ~6× on `UNNEST`-heavy views). Safe for order-insensitive flatten output; add an
  explicit `ORDER BY` only if a consumer needs order.
- **Constants `%name`**: substitute the constant value as a SQL literal.
- **Recursive CTEs**: one leading `WITH RECURSIVE`; mix non-recursive CTEs freely.

---

## 14. When to use Spec D

- **The default for production** when any view may contain independent fan-out
  forks (sibling `forEach`/`repeat` that each expand). It is the fastest measured in
  both fork topologies and degrades to Spec C (its equal) on pure chains.
- It is **strictly more general than Spec C** (which re-expands fork branches and can
  be 5–25× slower on a nested fork) and **faster than Spec B** (scalar key beats
  `LIST` equality; keys are generated lazily, not at every level).
- It is **more complex to generate** than B or C — it requires a fork analysis and
  per-scope mode selection. When you want the leanest generator and your views are
  chain-shaped, **Spec C** is simpler and equal. When you want one uniform rule and
  accept the `LIST`-key cost, **Spec B** is simpler. **Never Spec A** for
  nested/sibling/`repeat` or large batches.
- Pair with a **typed leaf binding** (§2) when a schema is available — it removes the
  JSON-access cost on top of the strategy win (measured 0.5–0.6 s vs 2.5–3.0 s).
