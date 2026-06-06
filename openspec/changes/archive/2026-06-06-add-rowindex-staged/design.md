## Context

`%rowIndex` is the SQL-on-FHIR environment variable giving the 0-based position of the current
element within its enclosing iteration. The reference suite is `tests/spec-tests/row_index.json`
(9 sub-tests). It is implemented on the `struct` backend (`add-rowindex-struct`) and excluded from
`spec.staged.test.js`.

Two pieces of plumbing already exist from the struct change and are reused unchanged:

1. **Front end.** `src/fhirpath-parser.js` recognizes `%rowIndex` as a contextual segment
   `{ segmentType: "rowIndex", type: { fhirType: "integer", isArray: false } }` (it does not route
   through the `--var` lookup). So staged already *parses* `%rowIndex` without error.
2. **`astToSql` row-index parameter.** `astToSql(node, inLambda, inputType, rootVar, rowIndexSql="0")`
   emits the `rowIndex` segment as the `rowIndexSql` string. The struct backend rebinds it inside an
   indexed `list_transform` lambda; the staged leaf compiler currently passes only four arguments,
   so `%rowIndex` defaults to `"0"` everywhere — silently wrong, hence the suite exclusion.

The staged emitter is a code generator that walks the **ViewDefinition JSON tree** (`emitScope`,
`collectScope`, `subtreeHasFork`), accumulating SQL strings in `ctes`. A column's FHIRPath is a
*string* (`col.path`); it is parsed into an AST lazily, one path at a time, inside
`compileColumn`/`compilePath` (`fhirpathToAst`), then turned into SQL and discarded. There is no
persisted whole-view AST.

The staged emitter realizes a `forEach` as `UNNEST(arr) WITH ORDINALITY AS u(node, ord)`
(`unnestFrom`), already producing a 1-based ordinal. Today the ordinal is emitted only when
`f.needsOrd = subtreeHasFork(f.node)` — its sole current purpose is fork recombination, where the
ordinal is appended to the `childKey` and used in the eventual fork `USING (…)` join. `%rowIndex`
adds a second reason to want that ordinal.

## Goals / Non-Goals

**Goals:**
- Compile and correctly evaluate `%rowIndex` on the `staged` backend for: resource root, `forEach`,
  `forEachOrNull` (including the empty/null row → `0`), nested `forEach` (independent per-level
  indices), `unionAll` with per-branch `forEach` (independent per-branch sequences), `unionAll`
  branches without their own `forEach` (inherit the enclosing index), and `unionAll` nested inside a
  `forEach`.
- Keep the change localized to `src/staged-sql-builder.js` and the staged test wiring.
- Preserve existing fork-recombination behavior exactly (the ordinal-as-key path is unchanged).

**Non-Goals:**
- Depth-first pre-order numbering for `%rowIndex` over `repeat`. The staged `repeat` descent is a
  `WITH RECURSIVE` CTE (breadth-first by level) with no per-node position column; matching the
  reference pre-order (`linkId 1,1.1,1.2,2 → 0,1,2,3`) requires carrying a materialized-path
  ordering key, a `row_number()` window, and a forced per-resource partition key (`rid`) even for
  non-forking repeat views. This is left as a known failure, mirroring the struct suite's current
  state, and is a candidate follow-up (`add-rowindex-repeat-preorder`, both backends — note staged
  *can* achieve it: DuckDB orders a `LIST` column lexicographically, verified).
- Struct backend, FHIRPath front end, and `astToSql` — unchanged.
- `%rowIndex` inside `where` predicates (not exercised by the suite).

## Decisions

### D1: Thread `%rowIndex` on the element descriptor

The staged emitter passes an element descriptor (`{ref, inLambda, seed, inputType}`) to every leaf
compilation (`rootElem`, `f.childElem`, `bridgeElem`). Add a `rowIndexSql` field. `rootElem` gets
`"0"`. `compilePath`, `compileColumn`, and `arrayize` read `elem.rowIndexSql || "0"` and pass it as
`astToSql`'s 5th argument. The `rowIndex` segment then emits it. Because the descriptor already
flows everywhere a leaf is compiled, the index rides along with no separate threading parameter.

*Alternative considered:* a standalone `rowIndexSql` parameter threaded through `emitScope`/
`emitUnion`/`emitRepeat` alongside `keyCols`. Rejected — the element descriptor already reaches
every compile site (including `prepUnion`'s columns-only materialization), so attaching the index
to it is strictly less plumbing and cannot drift out of sync with the element it indexes.

### D2: The ordinal exists if a fork **or** `%rowIndex` needs it; it is a key only for forks

`unnestFrom` emits `WITH ORDINALITY` iff given an `ordName`. Decouple the two consumers of the
ordinal:

- **Fork** needs the ordinal both aliased in the `FROM` and appended to `childKey` (recombination
  join key) — unchanged.
- **`%rowIndex`** needs the ordinal only aliased in the `FROM`, so the column expression `(ord - 1)`
  can reference it. It is materialized into an ordinary column in that same stage and carried as
  data; the raw ordinal does not need to travel.

Concretely:

```
const ordForFork  = subtreeHasFork(f.node);
const ordForIndex = scopeUsesRowIndex(f.node);
const ordName  = (ordForFork || ordForIndex) ? `ord${keyCols.length}` : null;
const childKey = ordForFork ? [...keyCols, ordName] : keyCols;   // key only for forks
f.childElem.rowIndexSql = ordName ? `(${ordName} - 1)` : "0";    // (coalesce for orNull, see D3)
```

*Why look-ahead is required.* The ordinal decision is made by the **parent** when it builds the
child's `FROM` string (`unnestFrom`), which is emitted *before* the parent recurses into the child,
where the child's column paths are finally parsed and reveal the `rowIndex` segment. A code
generator decides outer (container) structure before inner (contents); `WITH ORDINALITY` is part of
the container and cannot be retrofitted once the `FROM` text is emitted. So the parent must inspect
the child's not-yet-compiled columns. (For forks this look-ahead already exists as
`subtreeHasFork`.)

*Alternative considered — emit `WITH ORDINALITY` unconditionally on every `UNNEST`.* This would
delete the look-ahead entirely (no `scopeUsesRowIndex`, no parent/child timing concern): every
iteration would always expose an ordinal, and `%rowIndex` would just read it. Rejected on
**measured cost**. DuckDB does **not** prune an unreferenced ordinality column — it generates one
extra `BIGINT` per emitted row at each level and carries it through every staged CTE to the sink.
On the `nested_foreach_view` staged form over a 1000-resource QuestionnaireResponse dataset
(3,125,000 output rows, DuckDB 1.5.2, `explain.sh --mode materialize`, median of 3 runs), adding an
unused ordinal to all three `UNNEST`s raised wall time from **1.86 s → 2.20 s (~+18%)**, with both
variants emitting identical rows. The overhead is a flat, parallel-safe per-row column-carrying
cost — *not* the blocking-window penalty of `row_number() OVER ()`, and *not* the ~100×
aggregate-fold regression that only applies to aggregate-only unnests (a flattening forEach expands
every row regardless, so that fast path is never in play). Modest but strictly wasted work on the
hot flattening path that the overwhelming majority of views exercise *without* `%rowIndex`. Gating
ordinality on actual consumption keeps the common case free; the look-ahead is the price for that,
paid once at build time.

### D3: `forEachOrNull` null row reports 0 via `coalesce`

`forEachOrNull` emits `LEFT JOIN UNNEST(arr) WITH ORDINALITY AS u(node, ord) ON TRUE`. For an empty
collection the synthesized null row has `ord = NULL`, so `(ord - 1)` would be `NULL`. Bind
`%rowIndex` to `(coalesce(${ordName}, 1) - 1)` so the null row reports `0` while non-empty rows are
unaffected. This is the staged analog of the struct backend's source-side null padding (struct D4).

### D4: `unionAll` — per-branch ordinal for `forEach` branches, inherited index for columns-only

In `emitUnion`/`prepUnion`:

- A `forEach`/`forEachOrNull` branch (`e.arrCol`) currently unnests without ordinality. When the
  branch's columns use `%rowIndex`, emit `… UNNEST(…) WITH ORDINALITY AS _b(node, ord)` and set the
  branch `childElem.rowIndexSql = (ord - 1)` (coalesce for `orNull`). Each branch has its own
  ordinal, so branches number from `0` independently.
- A columns-only branch materializes its columns into the **owning scope's stage** via `prepUnion`
  (`B.compileColumn(c, elem)`), where the enclosing iteration's ordinal is already in scope. It
  inherits `elem.rowIndexSql` unchanged — `"0"` at the root, or the enclosing `forEach`'s
  `(ord - 1)` when nested. No new machinery; D1 already carries it. This satisfies "a non-iterating
  `unionAll` branch inherits the enclosing index."

Note: a columns-only union branch that uses `%rowIndex` while nested under a `forEach` requires that
`forEach`'s ordinal to exist. This is covered by `scopeUsesRowIndex` (D5) also inspecting columns-only
union branches.

### D5: Detect `%rowIndex` by parsing for the `rowIndex` segment

`scopeUsesRowIndex(node)` returns true if any column that compiles **against this scope's element**
references `%rowIndex`. Those columns are: `collectScope(node).columns` (direct + transparently
merged) and any columns-only `unionAll` branch (recursing through nested unions). It excludes
columns under a nested `forEach`/`forEachOrNull`/`repeat` and under `forEach`/`repeat` union
branches — each opens its own ordinal and is detected when *its* parent makes the same decision.

Detection parses each candidate path with `fhirpathToAst` (against the scope element's seed) and
walks the AST for a `{segmentType: "rowIndex"}` node.

*Alternative considered:* regex `/%rowIndex\b/` on the raw path strings (cheaper, matches the raw-
string idiom of `repeat-lowering.js`). Rejected in favor of parsing: it is precise (no false
positive on a `'%rowIndex'` string literal), reuses the real front end, and this is build-time
string assembly where re-parsing a handful of paths costs nothing.

## Risks / Trade-offs

- **[`repeat` sub-test left failing]** → Accepted and documented as a known follow-up, mirroring the
  struct suite. Ordering-only; no compile or correctness regression for other repeat views (their
  tests compare result sets and are unaffected).
- **[Look-ahead detection touches the ordinal decision, a fork-recombination hot path]** → Mitigated
  by keeping the fork path (`subtreeHasFork` → `childKey`) byte-for-byte unchanged and adding the
  index need as a separate disjunct that only affects `FROM`-aliasing in the index-only case. The
  full existing staged spec suite (both `natural` and `uuid` root-key modes) must stay green.
- **[Un-excluding `row_index.json` makes test 4 a visible red]** → Intended and precedented: the
  struct suite already carries the same documented red. The other 8 sub-tests assert the new
  behavior.
