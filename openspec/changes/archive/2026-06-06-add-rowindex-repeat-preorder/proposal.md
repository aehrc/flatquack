## Why

`%rowIndex` is supported on the `staged` (SPEC_hybrid) backend for the structural cases
(`add-rowindex-staged`), but `%rowIndex` over `repeat` was left as a documented known failure: the
staged `repeat` descent is a `WITH RECURSIVE` CTE that accumulates **breadth-first by level**, while
SQL-on-FHIR pins **depth-first pre-order** numbering (`linkId 1, 1.1, 1.2, 2 → 0, 1, 2, 3`). Today
the `repeat` fan-out never threads a row-index expression into its body, so `%rowIndex` over a
`repeat` compiles to the default `0` everywhere, and the `row_index.json` `repeat` sub-test is red on
the staged suite (mirroring struct). This change closes that gap on `staged` — the deferred
follow-up named `add-rowindex-repeat-preorder` in `add-rowindex-staged`.

The mechanism is the one prescribed by `specs/SPEC_hybrid.md` §11 and hinted in the
`add-rowindex-staged` design (D2 alternative-considered: "DuckDB orders a `LIST` column
lexicographically, verified"): carry a **materialized integer descent path** through the recursive
CTE and assign `%rowIndex = row_number() OVER (PARTITION BY <enclosing key> ORDER BY path) - 1` at
the repeat's bridge stage. Lexicographic ordering of the per-level ordinal lists reproduces pre-order
(`[1] < [1,1] < [1,2] < [2]`), and the index is assigned once per visited node, before any
recombination.

## What Changes

- Thread `%rowIndex` into a `repeat` body: when the repeat scope uses `%rowIndex`, carry a
  `path BIGINT[]` of per-level ordinals through both legs of the `WITH RECURSIVE` descent (seed leg
  binds `[ord]`; recursive leg binds `list_append(parent_path, ord)`, each `ord` from an added
  `UNNEST … WITH ORDINALITY`), then bind `%rowIndex` to
  `(row_number() OVER (PARTITION BY <key> ORDER BY path) - 1)` in the typed bridge stage. The index
  is materialized as a scalar and carried through any later fork join unchanged.
- Generalize the lazy-key look-ahead so the partition key always exists where a `repeat` below uses
  `%rowIndex`, even in fork-free views: force the root `rid` and force enclosing `forEach` steps to
  mint their ordinal as a carried key down the spine to that repeat — exactly the existing
  `subtreeHasFork` machinery, with a second disjunct. A `repeat` nested inside a `repeat` chains its
  partition by appending the outer repeat's own `%rowIndex` to the carried key (`(rid, outer_rn)`),
  so nested repeats never `PARTITION BY` a list.
- Extend `%rowIndex` detection to `repeat` fan-outs: run the existing `scopeUsesRowIndex` against the
  repeat's typed bridge element, add a `subtreeHasRepeatUsingRowIndex` look-ahead for the key
  forcing, and reach into `unionAll` branches that are themselves `repeat`s.
- Keep the change fully gated on usage: a `repeat` whose body does not reference `%rowIndex` emits no
  descent path, no ordinal, and no window — its generated SQL and keys are byte-for-byte unchanged.
- Tests: add `tests/spec-tests/row_index_repeat.json` (extended staged-only repeat cases not covered
  by the official `row_index.json`) and a dedicated staged-only runner; the existing `row_index.json`
  `repeat` sub-test flips to green on the staged suite.
- Scope: `staged` backend only. The `struct` backend keeps its matching documented red as a separate
  follow-up.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `staged-sql-emitter`: extends the `%rowIndex` requirement to cover `repeat` — depth-first
  pre-order numbering via a materialized integer descent path and a path-ordered window, partitioned
  by the (forced-if-necessary) enclosing-scope key, with repeat-in-repeat index chaining; removes the
  prior "`repeat` out of scope" carve-out.

## Impact

- `src/staged-sql-builder.js`: carry `path` through `emitRepeat`'s recursive CTE and assign the
  path-ordered `row_number()` window in the bridge when the repeat uses `%rowIndex`; widen the key
  look-ahead (`viewHasFork`/`forkOrd`) with a `subtreeHasRepeatUsingRowIndex` disjunct so the
  partition key is forced; detect `%rowIndex` on the `repeat` fan-out and through `repeat` union
  branches.
- `src/repeat-lowering.js`: only if the descent fold needs an ordinality-aware helper; otherwise
  unchanged.
- `tests/spec-tests/row_index_repeat.json` (new, `skip:true` for auto-discovery) and a dedicated
  staged-only loader test; no exclusion needed in `spec.staged.test.js` (the official `row_index`
  repeat sub-test now passes there).
- No public CLI/API surface changes. `astToSql`, the FHIRPath front end, and the `struct` backend
  are unchanged.
