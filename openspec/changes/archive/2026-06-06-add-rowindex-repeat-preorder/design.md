## Context

`%rowIndex` is the SQL-on-FHIR environment variable giving the 0-based position of the current
element within its enclosing iteration. On the `staged` backend it is implemented for the structural
cases (`add-rowindex-staged`) but **not** for `repeat`, which that change documented as a Non-Goal
and a named follow-up (`add-rowindex-repeat-preorder`). The reference is the `repeat` sub-test of
`tests/spec-tests/row_index.json`:

```
QuestionnaireResponse qr1, repeat:["item"]
  item 1 ├ 1.1  └ 1.2     item 2
expect item_index = 0,1,2,3  for linkId  1, 1.1, 1.2, 2   ← depth-first PRE-ORDER
```

Two distinct gaps exist today:

1. **No index is threaded.** The `repeat` fan-out (`emitScope`'s `repeatFanouts` dispatch) never sets
   `f.childElem.rowIndexSql`, and the typed `bridgeElem` carries none, so every leaf reads
   `elem.rowIndexSql || "0"` → `%rowIndex` compiles to `0` for the whole repeat body.
2. **Wrong order even if threaded.** `emitRepeat` lowers `repeat` to a `WITH RECURSIVE` CTE whose
   seed leg emits the top-level descendants and whose recursive leg descends one level at a time —
   breadth-first by level (`1, 2, 1.1, 1.2`), not the pinned pre-order (`1, 1.1, 1.2, 2`).

Two further facts shape the design:

- **Results are compared order-independently** (`spec.staged.test.js` does `new Set(result)` vs
  `new Set(expect)`). So pre-order correctness is verified by the **index value bound to each row**,
  not by output row order — the window need only assign the right integer to each visited node.
- **The headline test is a CHAIN, not a fork.** Its `id` column is a columns-only sibling, so the
  root has a single fan-out child (the `repeat`) ⇒ `subtreeHasFork` is false ⇒ `rootKey = []`. The
  repeat CTE carries **no key**. With only `qr1` in the data a key-less global numbering happens to be
  correct; with ≥2 resources it is not. So a correct fix must **force** a per-resource partition key
  even absent a fork (this is the "forced `rid`" the `add-rowindex-staged` design flagged).

## Goals / Non-Goals

**Goals:**
- Evaluate `%rowIndex` over `repeat` on `staged` as **depth-first pre-order**, restarting per the
  repeat's enclosing-scope instance, for: a root repeat; a fork-free lone repeat over multiple
  resources; a repeat nested inside a `forEach`/`forEachOrNull`; a repeat nested inside a `repeat`
  (index chaining); a repeat inside a `unionAll` branch; and a repeat that is one of ≥2 fan-out
  siblings (a fork), where the index must survive recombination.
- Keep the change localized to `src/staged-sql-builder.js` (+ `repeat-lowering.js` only if a descent
  helper needs ordinality) and the staged test wiring.
- Gate everything on usage: a `repeat` not using `%rowIndex` produces byte-for-byte identical SQL.

**Non-Goals:**
- The `struct` backend. Its `row_index.json` `repeat` sub-test stays a documented red; struct
  pre-order remains a separate follow-up.
- `%rowIndex` inside `where` predicates (not exercised by the suite).
- Non-simple `repeat` paths (already rejected by `assertSimplePath`).
- Changing the breadth-first **execution** of the descent. The CTE still accumulates by level; only
  the *numbering* is made pre-order, via the carried path and the ordering window. (Rows are
  reordered logically by the window, not physically re-traversed depth-first.)

## Decisions

### D1: Carry a materialized integer descent path through the recursive CTE

When the repeat scope uses `%rowIndex`, both legs of the `WITH RECURSIVE` descent expose an ordinal
via `WITH ORDINALITY` and carry a `path BIGINT[]` of per-level ordinals:

```sql
rep AS (
  SELECT <carry>, [ord]::BIGINT[] AS path, _s.node AS node
  FROM <parent>, UNNEST(<parent>.<seed>) WITH ORDINALITY AS _s(node, ord)
  UNION ALL
  SELECT <carry>, list_append(rep.path, ord), _r.node
  FROM rep, UNNEST(<jsonFold>) WITH ORDINALITY AS _r(node, ord)
)
```

A node's path is the sequence of 1-based child positions from the seed down to it
(`1 → [1]`, `1.1 → [1,1]`, `1.2 → [1,2]`, `2 → [2]`). DuckDB orders a `LIST` **element-wise**, with
a shorter prefix sorting before its extensions (`[1] < [1,1] < [1,2] < [2]`), which is exactly
depth-first pre-order. The path is ordered as an **integer list**, never a string: a string path
mis-sorts at ≥10 siblings (`"1.10" < "1.2"`), an `int[]` does not.

*Why the path must be carried (not derived).* After the `UNION ALL` accumulates all levels, a node's
ancestry and sibling position are no longer recoverable from `node` alone; the only way to recover
pre-order is to have recorded the per-level ordinal at descent time. The path is a tiny `BIGINT[]`
carried (not joined), so it is cheap (SPEC_hybrid §11 Cost: effectively free — the window is a sort
dwarfed by the recursion + JSON parse).

### D2: Assign the index at the bridge stage, before any recombination

The index is computed once per visited node in the typed bridge CTE (`repb`), then bound as the
body's `rowIndexSql`:

```sql
repb AS (
  SELECT <carry>,
         (row_number() OVER (PARTITION BY <key> ORDER BY path) - 1)::INTEGER AS rep_rn,
         <cast>(node) AS el
  FROM rep
)
-- then: f.childElem.rowIndexSql = "rep_rn"
```

The body scope (`emitScope(... fromSql = repb)`) already reads `FROM repb`, so `rep_rn` is in scope
exactly like a `forEach`'s aliased ordinal. Assigning **before** recombination is mandatory
(SPEC_hybrid §11 rule 1): computing `row_number()` on the final flattened output would let a sibling
cross-product inflate the index. Because `rep_rn` is materialized as an ordinary scalar column, it
rides through any subsequent fork `JOIN … USING(key)` unchanged.

### D3: Force the partition key to exist — generalize the fork look-ahead

The window must `PARTITION BY` the repeat's enclosing-scope instance, or nodes from different
resources / different enclosing iterations share one numbering. The staged emitter only mints
`rid`/ordinals on spines that reach a fork (SPEC_hybrid §13 "lazy keys"), so a fork-free repeat
carries no key. Generalize the existing look-ahead: treat **"a `repeat` below uses `%rowIndex`"** as a
second reason to force the key, alongside `subtreeHasFork`.

- **Root.** `rootKey = (viewHasFork || viewHasRepeatUsingRowIndex) ? ["rid"] : []`. A fork-free
  repeat view now carries `rid`.
- **Enclosing `forEach`/`forEachOrNull`.** The ordinal becomes a carried **key** when
  `subtreeHasFork(f.node) || subtreeHasRepeatUsingRowIndex(f.node)` (today it is only `forkOrd`). So
  the spine carries `(rid, ord_1, …)` down to the repeat; at `emitRepeat`, `keyCols` **is** the
  partition key.
- **Enclosing `repeat`.** A `repeat` nested inside a `repeat` partitions the inner window by the
  outer's own scalar `%rowIndex` (`rep_rn`): the outer `emitRepeat` appends its `rep_rn` to the
  `keyCols` it threads into its body when an inner repeat uses `%rowIndex`. This is SPEC_hybrid §11's
  `(rid, outer_rn)` chaining — symmetric to how a `forEach` appends `ord` to `childKey` — and avoids
  ever partitioning by a `LIST`.

The result: at every `emitRepeat` that uses `%rowIndex`, `keyCols` is guaranteed non-empty and
identifies exactly the enclosing iteration instance. Partition by `keyCols`.

*Why look-ahead (not retrofit).* As with forks (`add-rowindex-staged` D2), the parent decides the
spine's key columns when it builds the child's `FROM`, before recursing into the child where the
column paths reveal `%rowIndex`. So the parent must inspect the not-yet-compiled subtree — exactly
what `subtreeHasFork` already does; `subtreeHasRepeatUsingRowIndex` is its analog for repeat.

### D4: Detect `%rowIndex` on the repeat fan-out and through repeat union branches

The existing `scopeUsesRowIndex(node, elem)` parses a scope's candidate column paths for the
contextual `rowIndex` segment. Extend usage:

- On the `repeat` fan-out, set `f.usesRowIndex = scopeUsesRowIndex(f.node, f.childElem)` (against the
  repeat's typed bridge element) — today it is computed only for `forEach`.
- Add `subtreeHasRepeatUsingRowIndex(node)`: any `repeat` in the subtree whose body uses `%rowIndex`
  (recursing through `select`, `forEach`/`forEachOrNull`, and `unionAll` branches). Drives D3's key
  forcing.
- `scopeUsesRowIndex`'s union recursion already descends columns-only branches; ensure a `repeat`
  union branch is recognized as opening its own iteration (its `%rowIndex` is the repeat's, detected
  when that branch is lowered), consistent with the existing `forEach`-branch handling.

### D5: Rejected alternatives

- **Reuse the breadth-first order.** Numbering nodes in CTE accumulation order gives `1,2,1.1,1.2 →
  0,1,2,3` bound to the wrong nodes. Wrong by inspection; this is the current red.
- **Synthetic `row_number() OVER ()` parent id.** Mint a unique id per repeat-parent row and
  partition by it (handles repeat-in-repeat "for free"). Rejected: `row_number() OVER ()` is a
  *blocking* global window on a hot stage — exactly the penalty `add-rowindex-staged` D2 spent
  measurements avoiding. The scalar-key chaining (D3) is cheaper and is the established house style
  (scalar lazy keys, SPEC_hybrid §4/§13).
- **Always emit the descent path + window.** Deletes the look-ahead but pays an unused `BIGINT[]`
  carry + a sort on every `repeat`, the overwhelming majority of which never use `%rowIndex`.
  Rejected on the same gating principle as `add-rowindex-staged` D2; the common repeat path stays
  free.

## Risks / Trade-offs

- **[Repeat-in-repeat with `%rowIndex` is not in `row_index.json`]** → D3's chaining makes it
  correct, but the official suite never exercises it. Mitigated by `row_index_repeat.json` (a
  dedicated extended fixture, staged-only) that pins the chaining (inner index restarts per outer
  node).
- **[Forcing keys onto previously key-less chains]** → A fork-free repeat-with-`%rowIndex` spine now
  carries `rid[,ord…]`. This adds carried scalar columns but introduces **no joins** (joins occur
  only at forks); it is the same lazy-key data a fork-reaching spine already carries. Gated on usage,
  so non-`%rowIndex` repeats are unchanged. The full existing staged suite (both `natural` and `uuid`
  root-key modes) must stay green.
- **[The extended fixture must not run under the struct suite]** → `row_index_repeat.json` is
  staged-only. It is marked `skip:true` so the generic auto-discovery in both `spec.test.js` and
  `spec.staged.test.js` ignores it, and a dedicated staged-only runner loads it directly (the
  established pattern of `staged-repeat.test.js`). The official `row_index.json` repeat sub-test,
  which *is* auto-discovered, simply flips from red to green on the staged suite.
- **[Logical vs physical order]** → The window reorders rows logically for numbering only; the CTE
  still executes breadth-first. Correct under the order-independent Set comparison and under
  `preserve_insertion_order = false` (the index is a value, not output position).
