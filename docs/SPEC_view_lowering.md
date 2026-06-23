# View Lowering — staged CTEs with lazy fork keys

How flatquack lowers a SQL-on-FHIR **ViewDefinition** into a single DuckDB SQL
query. The emitter walks the ViewDefinition tree, classifies each `select` scope,
and lowers it to a chain of CTEs that flatten the resource into the view's rows.

The whole design rests on one decision made at every scope: **chain when you can,
key only at forks.**

- A scope with **at most one** fan-out child is a **chain**: materialise the child
  array as a column, `UNNEST` it in the next stage, carry scalars forward. No keys,
  no joins.
- A scope with **two or more** independent fan-out children is a **fork**: compute
  each branch once as its own chain and recombine them with a `JOIN` on the scope's
  key. The key is generated **lazily** — only on spines that actually reach a fork,
  and only as deep as the fork: a scalar resource key at a root fork, a small
  composite scalar key `(resource, ordinal, …)` at a nested fork.

A view with no fork anywhere is a pure chain — no keys are emitted at all.

Implementation: `src/staged-sql-builder.js` (the emitter), `src/repeat-lowering.js`
(`repeat` descent), `src/query-builder.js` (read schema), `src/view-parser.js`
(ViewDefinition normalisation). The companion [SPEC_ondemand_typing.md](./SPEC_ondemand_typing.md)
covers how typed columns coexist with a `repeat`'s raw-JSON descent;
[SPEC_sql_template_contract.md](./SPEC_sql_template_contract.md) covers how this generated
pipeline plugs into a template (the `fq_sql_*` variable contract).

---

## 1. Input model & semantics

The input is a normalised ViewDefinition: a tree of `select` scopes, each carrying
`column`s and row-producing **directives** (`forEach`, `forEachOrNull`, `repeat`,
`unionAll`, nested `select`), plus an optional `where` and a top-level `resource`
type. FHIRPath expressions appear in `column.path`, directive paths, and `where`.

Each scope evaluates against a **context element** (a resource at the root, an array
element after a fan-out). Within a scope the directives compose as a **per-parent
Cartesian product**: each parent instance produces the cross product of its
children's rows. Directive cardinalities:

| directive       | rows per parent | notes |
|-----------------|-----------------|-------|
| `column`        | ×1              | one value per row; `collection:true` keeps the whole collection as one array value |
| `forEach`       | ×0..N           | iterate a collection; an empty collection drops the parent row |
| `forEachOrNull` | ×1..N           | as `forEach`, but an empty collection yields one row with NULLs |
| `repeat`        | ×0..N           | transitively descend the listed paths, **excluding the seed**; emits all descendants |
| `unionAll`      | concatenation   | vertical union of branches that share an identical column set |

The output is exactly the view's columns, in tree order.

---

## 2. The FHIRPath leaf layer (assumed)

The emitter does not interpret FHIRPath. It relies on a **leaf translation layer**
(`src/ddb-sql-builder.js`) that compiles a FHIRPath expression — evaluated against a
named context element — into a SQL expression over that element's columns. The
emitter uses it through three roles:

- **column** — a SQL scalar (or, for `collection:true`, an array) for `column.path`.
- **array** — for a fan-out directive, the SQL expression producing the child
  collection to be `UNNEST`ed.
- **predicate** — a boolean SQL expression for a `where` path.

The source binding is typed: `src/query-builder.js` reads FHIR resources with
`read_json_auto` under a `STRUCT` schema derived from the FHIR StructureDefinitions,
so each field arrives as a typed SQL column. Fields that a `repeat` must descend
recursively cannot be a finite `STRUCT`, so they are read as `JSON[]` and re-typed
on demand at navigation sites — see the companion spec. Everything below is
independent of how the leaf layer is realised; it depends only on the three roles
above.

The source CTE:

```sql
WITH src AS (
  SELECT *            -- typed columns from the read schema
  FROM read_json_auto('{FILE}', ...)
  WHERE resourceType = '{vd.resource}'   -- only if vd.resource is set
)
```

---

## 3. Two disciplines

These two rules are what keep the lowering set-based and fast; every template below
obeys them.

**Discipline 1 — materialise, then `UNNEST`.** Never `UNNEST` a correlated path
expression directly. Always materialise the child collection as a *named column* in
the parent stage, then `UNNEST` that column in the next stage. The `UNNEST` target is
then a plain column of the driving row, which DuckDB executes set-based rather than
decorrelating into a join cascade.

**Discipline 2 — never carry a resource node through a fan-out.** Project each
column at the stage that owns its context element; carry forward only scalars and the
arrays still needed downstream. Carrying a whole multi-field resource element across a
fan-out duplicates it per produced row. In a fork, this is why each branch is reduced
to scalars *before* the recombination join — the join then replays cheap scalar rows.

---

## 4. The chain-vs-fork decision

At every scope, count its **fan-out children** — directives that can produce more than
one row: `forEach`, `forEachOrNull`, `repeat`, and a `unionAll` whose branches fan out.

| fan-out children | mode  | mechanism |
|------------------|-------|-----------|
| 0 or 1           | CHAIN | carry-forward staging — no key, no join |
| ≥2               | FORK  | keyed recombination — each branch computed once, joined on the scope key |

Keys are emitted **only** on spines that reach a fork. A fork-free view lowers to a
pure chain.

---

## 5. The fork key (lazy, scope-scoped, scalar)

A fork's recombination key is the **fork scope's context key**: the resource key,
extended by the **1-based ordinal of each iterating step** on the spine from the root
(or nearest enclosing fork) down to the fork scope.

```
resource #r                          key = (r)
  forEach item #i                    key = (r, i)
  forEach item #i → forEach x #j     key = (r, i, j)
```

The key is represented as **separate scalar columns** `(_rid, _ord1, …, _ordk)` and
joined with `USING`. Generated lazily:

- `_rid` — the resource key, emitted **once** in `src` (e.g. `row_number() OVER ()`,
  or the resource's own `id`). Emitted only if some fork (or a `%rowIndex` `repeat`)
  below needs it.
- `_ordi` — the ordinal at the *i*-th iterating step on a spine that leads to a fork.
  Emitted via DuckDB's positional zip: `UNNEST(col) WITH ORDINALITY`, or
  `generate_subscripts(arr, 1)` alongside `unnest(arr)` in a SELECT. A chain that reaches
  no fork emits no ordinal **unless its own scope reads `%rowIndex`** (which needs a private
  ordinal at that step); a `forEach` whose scope needs neither emits a plain `UNNEST`.

At a **root** fork the key is just `_rid`. At a **nested** fork it is
`(_rid, _ord1, …)`. The branches of a fork carry the same key columns and recombine
by `JOIN … USING (_rid, _ord1, …)`.

> A nested fork's key **must** include the ordinals. Joining on `_rid` alone
> cross-products every item's branch-A rows with every item's branch-B rows within the
> same resource.

---

## 6. Per-directive templates

### column — folds into the owning stage, never its own CTE

```sql
{col_sql(c, elem)}  AS {c.name}    -- scalar, or array when c.collection = true
```

### forEach / forEachOrNull — CHAIN mode

The parent stage materialises the child array as a column; the child stage `UNNEST`s
that column. `, UNNEST(col)` is `forEach` (inner — an empty array drops the row); a
`LEFT JOIN UNNEST(col) ON TRUE` over a `[NULL]`-padded column is `forEachOrNull`
(empty → one NULL row).

```sql
s_n AS (
  SELECT {carried scalars}, {this scope's columns},
         {arr_sql(childPath, elem)} AS _next_arr     -- materialise next level
  FROM {parent} [, | LEFT JOIN] UNNEST({parent}._arr) AS _u(elem) [ON TRUE]
)
```

### forEach / forEachOrNull — FORK mode

Each fan-out branch is emitted as its own chain off the fork stage `P`, carrying the
key `K` and reducing to scalar columns; then the branches recombine on `K`. `forEach`
branches join `INNER`, `forEachOrNull` branches `LEFT`.

```sql
a AS (SELECT {K}, {a's scalar columns} FROM P [LEFT JOIN] UNNEST(P._a_arr) AS _a(elem) [ON TRUE] /* …chain… */),
b AS (SELECT {K}, {b's scalar columns} FROM P [LEFT JOIN] UNNEST(P._b_arr) AS _b(elem) [ON TRUE] /* … */)

SELECT base.{fork-scope columns}, a.*, b.*
FROM {base keyed by K}
[LEFT] JOIN a USING ({K})
[LEFT] JOIN b USING ({K})
```

Each branch is computed once; the join replays scalar rows. A branch that is itself a
fork recurses, gaining its own deeper key.

### repeat

A `repeat` descends **only** the listed paths, recursively, excluding the seed. The
descent is a `WITH RECURSIVE` CTE: the base unnests the seed collection, the recursive
leg unnests the listed paths off each visited node. The descent runs over raw JSON
(the recursive field cannot be a finite `STRUCT`); each visited node is then converted
to a typed element with a lenient `from_json` bridge so the leaf layer compiles the
body's columns against typed columns (companion spec).

- **In a chain** (the `repeat` is its scope's only fan-out child): carry the scope's
  scalars into and through the recursive CTE; no key is minted.

  ```sql
  WITH RECURSIVE
  rep AS (
    SELECT {carried scalars}, _s.node AS node
    FROM {parent}, UNNEST({parent}._seed_arr) AS _s(node)      -- base: seed elements
    UNION ALL
    SELECT {carried scalars}, _c.node AS node
    FROM rep, UNNEST({listed paths off rep.node}) AS _c(node)  -- recurse: listed paths only
  )
  ```

- **At a fork** (a `repeat` beside another fan-out — `repeat` branches are always
  independent fan-outs): run the same descent but carry the fork key plus a per-node
  descent path, key the repeat scope by `(forkKey, path)`, and join it to its siblings
  on the fork key.

### unionAll

Non-iterating. In a chain, `UNION ALL` of branch pipelines that share an identical
column set. At a fork, each branch is keyed by the fork-scope key and joins like any
other child.

### where / resource

A `WHERE {pred_sql(path, elem)}` (or `WHERE resourceType = 'X'` for the top-level
`resource`) on the stage whose context element the predicate references; root filters
apply on `src`.

---

## 7. Scope composition

```
emitScope(scope, parentStage, ctxArrCol, key):
  # key = carried key columns (_rid[,_ord…]); empty until a fork is reached
  cols     = column projections of this scope        # fold into the stage
  fanouts  = row-producing children of this scope
  thisStage = CTE: SELECT {carried scalars}, cols,
                          {one materialised array column per fan-out child},
                          {if this scope is a fork: expose key columns}
                   FROM parentStage [, | LEFT JOIN] UNNEST(ctxArrCol) [ON TRUE]

  if |fanouts| <= 1:                                 # CHAIN
     for the (<=1) fan-out child:
        emitScope(child, thisStage, thisStage.<arr>, key)     # no new key; columns accumulate down the lineage

  else:                                              # FORK
     forkKey = key extended with this spine's ordinals down to thisStage
               (root fork => (_rid); nested fork => (_rid, _ord1, …))
     branches = [ (joinKind(child), emitBranch(child, thisStage, forkKey)) for child in fanouts ]
     base   = SELECT forkKey, cols FROM thisStage
     result = base joined to every branch USING (forkKey)     # INNER or LEFT per joinKind
     return SELECT base.cols + every branch's cols FROM result  # forkKey stays internal
```

- `joinKind`: `forEach` / `repeat` / `unionAll` ⇒ `INNER` (empty kills the row);
  `forEachOrNull` ⇒ `LEFT` (empty ⇒ one NULL row).
- Columns at a fork scope fold into `base` (no join), exactly as in a chain.
- An `_ordi` is generated **only** on a spine that reaches a fork. A subtree with no
  fork below it is pure carry-forward.

---

## 8. `%rowIndex` — positional index of an element

`%rowIndex` is the **0-based positional index of an element within the collection its
operator iterates, scoped to that operator's parent instance** — not a global
`ROW_NUMBER()` over the output (SQL-on-FHIR is order-agnostic; the index is
structural, computed at the unnest/descent step).

It reuses the ordinal machinery from §5, surfaced as a column value (minus 1, since the
ordinal is 1-based).

- **forEach / forEachOrNull** — the element's ordinal: `UNNEST(arr) WITH ORDINALITY AS
  t(elem, ord)` (chain), or `generate_subscripts(arr, 1)` zipped with `unnest(arr)` (fork).
  The `WITH ORDINALITY` is emitted **precisely when the scope reads `%rowIndex`** (or a fork
  below needs the ordinal as a key) — a `forEach` that uses neither pays nothing. `ord`
  resets to 1 per parent row, so `%rowIndex = ord - 1`. For a `forEachOrNull` empty→NULL row
  the ordinal is NULL, so `%rowIndex = COALESCE(ord, 1) - 1 = 0`.

- **repeat** — a `repeat` has no single parent collection, so the index is assigned **at
  the repeat scope** (one row per visited node, before any sibling recombination) by a
  window over the descent **path**, partitioned by the parent scope:

  ```sql
  ROW_NUMBER() OVER (PARTITION BY {parent-scope key} ORDER BY path) - 1
  ```

  A root repeat partitions by `_rid`; a nested repeat partitions by the enclosing
  scope's key. A repeat inside a repeat keys the inner index by `(_rid, outer_rn)`, so
  nested indices chain via scalars and never partition by a `LIST`. Order by the
  **int-list** path (a string path like `'1.2.1'` mis-orders past 10 siblings).

Computing `%rowIndex` on the final flattened output would be wrong: a sibling
cross-product inflates the row count and the index. It must be assigned at the
operator's own scope and carried through as a scalar.

---

## 9. Projection & internal identifiers

The final `SELECT` outputs **exactly** the view's columns, by `name`, in tree order —
nothing else. The key bookkeeping (`_rid`, `_ord*`, a repeat's descent `_path`, etc.)
threads through CTEs but never appears in the result.

Collisions are prevented structurally, not by convention. A view column name is a
validated SQL identifier matching `^[A-Za-z][A-Za-z0-9_]*$` (it must start with a
letter), so every internal identifier the emitter mints is **`_`-prefixed**
(`_rid`, `_ord{N}`, `_nord{N}`, `_node`, `_ord`, `_path`, the `repeat` bridge column)
and therefore cannot collide with any legal view column — even one literally named
`rid`, `node`, or `path`. (A view `column` named `id` is the FHIR `id`, unrelated to
`_rid`.)

---

## 10. Edge cases & notes

- **Lazy keys, literally.** Walk the tree first; mark fork scopes (≥2 fan-out
  children) and `%rowIndex`-using `repeat`s. Emit `_rid` / `_ordi` only on spines from
  the root to such a scope. A view with neither is a pure chain — no `row_number`, no
  ordinals, no joins.
- **Materialise before `UNNEST`, always** — even inside a fork branch. One correlated
  level is tolerable; stacked correlated levels decorrelate into a join cascade.
- **Reduce branches to scalars before recombining.** That is exactly why a fork join
  is cheap — it replays scalar rows rather than re-expanding nested data.
- **`forEachOrNull`** = a `[NULL]`-padded materialised column with `LEFT JOIN UNNEST …
  ON TRUE` (chain), or a `LEFT JOIN USING(key)` branch (fork). A plain `UNNEST` of an
  empty collection yields 0 rows; the `[NULL]` pad / `LEFT` join supplies the required
  NULL row.
- **Shallow shared-array siblings** — ≥2 `forEach` off one parent, none fanning out
  further. The emitter **always FORKs** at ≥2 fan-outs (the scope classifier is purely
  `≤1 → CHAIN`, `≥2 → FORK`; there is no shallow-sibling exception). In principle such
  siblings could stay a CHAIN (parallel `, UNNEST(col)` entries) — less SQL, same per-parent
  cross product — but a CHAIN cross-products the raw unnested structs whereas a FORK reduces
  each branch to its scalar projection first, so which is faster depends on struct width and
  the optimizer's projection push-down, not on SQL simplicity. Tracked as a benchmark-gated
  optimization in [#39](https://github.com/aehrc/flatquack/issues/39).
- **`collection` columns** keep the whole collection as one array value. A scalar
  column whose path yields more than one value is an error (rely on validation).
- **`preserve_insertion_order = false`** is a DuckDB **session setting**, not something
  this lowering emits. On DuckDB **1.5+** the result sink defaults to preserving insertion
  order, which serialises `UNNEST`-heavy materialisation and causes a significant
  performance regression; setting it `false` restores parallel materialisation. Apply it at
  the session/connection level (or in your own template) when running on 1.5+. It is safe
  for order-insensitive output (SQL-on-FHIR imposes no row order); add an explicit
  `ORDER BY` only if a consumer needs order.
- **Constants `%name`** substitute the constant value as a SQL literal.
- **Recursive CTEs** require one leading `WITH RECURSIVE`; non-recursive CTEs may be
  mixed in freely under it.
