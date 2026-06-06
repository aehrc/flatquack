## 1. Detection + key look-ahead

- [x] 1.1 Add `subtreeHasRepeatUsingRowIndex(node)`: true if any `repeat` in the subtree has a body that uses `%rowIndex`, recursing through `select`, `forEach`/`forEachOrNull`, and `unionAll` branches (D4)
- [x] 1.2 In the `repeat` fan-out prep, set `f.usesRowIndex = scopeUsesRowIndex(f.node, f.childElem)` against the repeat's typed bridge element (D4)
- [x] 1.3 Confirm a `repeat` union branch is recognized as opening its own iteration for detection (consistent with the existing `forEach`-branch handling) (D4)

## 2. Force the partition key (lazy-key generalization)

- [x] 2.1 Force the root key: `rootKey = (viewHasFork || viewHasRepeatUsingRowIndex) ? ["rid"] : []` (D3)
- [x] 2.2 Widen the `forEach`/`forEachOrNull` ordinal-as-key decision to `subtreeHasFork(f.node) || subtreeHasRepeatUsingRowIndex(f.node)`, so the spine carries `(rid, ord_i)` down to a repeat-using-`%rowIndex` even with no fork (D3)
- [x] 2.3 In `emitRepeat`, when an inner `repeat` below uses `%rowIndex`, append this repeat's `rep_rn` to the `keyCols` threaded into its body (the `(rid, outer_rn)` chaining) (D3)
- [x] 2.4 Confirm the existing fork key path (`subtreeHasFork → childKey`) is byte-for-byte unchanged for non-`%rowIndex` views

## 3. Descent path through the recursive CTE

- [x] 3.1 In `emitRepeat`, when `f.usesRowIndex`, add `WITH ORDINALITY` to the seed leg's `UNNEST` and carry `path = [ord]::BIGINT[]` (D1)
- [x] 3.2 Add `WITH ORDINALITY` to the recursive leg's `UNNEST(<jsonFold>)` and carry `path = list_append(rep.path, ord)` (D1)
- [x] 3.3 Confirm multi-path `repeat` (e.g. `["item", "answer.item"]`) numbers across the `list_concat`ed descent as a single child sequence (D1)
- [x] 3.4 When `f.usesRowIndex` is false, emit no ordinality, no `path`, no window — verify generated SQL is unchanged from before this change (D5 gating)

## 4. Assign `%rowIndex` at the bridge

- [x] 4.1 In the bridge CTE (`repb`), add `(row_number() OVER (PARTITION BY <keyCols> ORDER BY path) - 1)::INTEGER AS rep_rn` (D2)
- [x] 4.2 Set `f.childElem.rowIndexSql = "rep_rn"` so the repeat body's leaves read the pre-order index (D2)
- [x] 4.3 Confirm `rep_rn` is materialized as a scalar and survives a subsequent fork `JOIN … USING(key)` unchanged (assigned before recombination) (D2)

## 5. Test fixture + wiring

- [x] 5.1 `tests/spec-tests/row_index_repeat.json` exists (added in this change) with `skip:true`, two QuestionnaireResponses, and the five extended cases (fork-free multi-resource, repeat-under-forEach, repeat-in-repeat, repeat-in-unionAll, repeat-at-a-fork)
- [x] 5.2 Add a dedicated staged-only runner (e.g. `tests/row-index-repeat.test.js`) that reads `row_index_repeat.json` directly and runs each view through the **staged** template in both `natural` and `uuid` root-key modes, asserting `new Set(result)` equals `new Set(test.expect)`
- [x] 5.3 Run the new runner; confirm all five extended cases pass in both root-key modes
- [x] 5.4 Run `spec.staged.test.js`; confirm the official `row_index.json` `repeat` sub-test now passes (and all other `row_index` sub-tests still pass), in both root-key modes
- [x] 5.5 Run the full staged suite (`spec.staged.test.js`, `staged-repeat.test.js`, `staged-rootkey.test.js`); confirm no regressions — non-`%rowIndex` repeats and existing fork recombination unchanged
- [x] 5.6 Confirm `spec.test.js` (struct) is unaffected: `row_index_repeat.json` is skipped by auto-discovery, and the struct `row_index.json` `repeat` red remains as the documented struct follow-up

## 6. Spec + documentation

- [x] 6.1 Apply the `staged-sql-emitter` spec delta: the `%rowIndex` requirement covers `repeat` (pre-order via materialized integer path + path-ordered window, forced enclosing-scope partition, repeat-in-repeat chaining); the prior "`repeat` out of scope" paragraph is removed
- [x] 6.2 Update the `EXCLUDE`/comment note in `tests/spec.staged.test.js` to drop the "repeat sub-test left failing" caveat (it now passes on staged)
- [x] 6.3 Spot-check generated staged SQL for a root repeat, a repeat-under-forEach, and a repeat-in-repeat `%rowIndex` view (path carried, window partitioned by the expected key)
