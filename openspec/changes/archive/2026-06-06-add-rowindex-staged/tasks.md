## 1. Thread the row-index expression on the element descriptor

- [x] 1.1 Add `rowIndexSql` to the staged element descriptor: `rootElem` gets `"0"` (D1)
- [x] 1.2 In `compilePath`, `compileColumn`, and `arrayize` (`makeBuilder`), pass `elem.rowIndexSql || "0"` as `astToSql`'s 5th argument (D1)
- [x] 1.3 Confirm `%rowIndex` at the resource root compiles to `0` (no enclosing iteration), and that other `%`-constants are unaffected

## 2. Detection helper

- [x] 2.1 Add `scopeUsesRowIndex(node)`: parse each candidate column path with `fhirpathToAst` (against the scope element's seed) and walk for a `{segmentType:"rowIndex"}` node (D5)
- [x] 2.2 Candidate paths = `collectScope(node).columns` plus any columns-only `unionAll` branch, recursing through nested unions; exclude columns under nested `forEach`/`forEachOrNull`/`repeat` and under `forEach`/`repeat` union branches (D5)

## 3. `forEach` / `forEachOrNull` ordinal + binding

- [x] 3.1 In `emitScope`, decouple the ordinal decision: ordinal exists when `subtreeHasFork(f.node) || scopeUsesRowIndex(f.node)`; append it to `childKey` **only** for `subtreeHasFork` (D2)
- [x] 3.2 Set `f.childElem.rowIndexSql` to `(ord - 1)` for `forEach`, and `(coalesce(ord, 1) - 1)` for `forEachOrNull` so the null row reports `0` (D2, D3)
- [x] 3.3 Apply the same ordinal/binding in both the CHAIN and FORK realFanout paths
- [x] 3.4 Confirm nested `forEach` levels carry independent ordinals (distinct `ord${keyCols.length}` names) and report independent indices

## 4. `unionAll`

- [x] 4.1 In `emitUnion`/`prepUnion`, a `forEach`/`forEachOrNull` branch that uses `%rowIndex` unnests with `WITH ORDINALITY` and binds its `childElem.rowIndexSql = (ord - 1)` (coalesce for `orNull`); branches number from `0` independently (D4)
- [x] 4.2 Confirm a columns-only branch inherits the enclosing scope's `elem.rowIndexSql` with no extra machinery — `0` at the root, `(ord - 1)` when nested under a `forEach` (D1, D4)
- [x] 4.3 Confirm the `forEach`-with-`unionAll` case (test 7) gives the enclosing `forEach` index to the columns-only branch and the branch's own index to the `forEach` branch

## 5. Test wiring

- [x] 5.1 Remove the `row_index` exclusion (`EXCLUDE = /^row_index/`) from `tests/spec.staged.test.js`
- [x] 5.2 Run `spec.staged.test.js`; confirm all `row_index` sub-tests pass except the `repeat` sub-case (known follow-up), in both `natural` and `uuid` root-key modes
- [x] 5.3 Run the full staged test suite and confirm no regressions (existing fork recombination unchanged)
- [x] 5.4 Spot-check generated staged SQL for a `forEach` + `%rowIndex` view, a nested `forEach` view, and the `unionAll`-inside-`forEach` view

## 6. Documentation

- [x] 6.1 Confirm the design's `repeat` Non-Goal is captured and points at the `add-rowindex-repeat-preorder` follow-up
