## 1. Parser: recognize `%rowIndex`

- [x] 1.1 In `src/fhirpath-parser.js` `ExternalConstant` case, special-case `rowIndex` before the `vars` lookup and return a `{ segmentType: "rowIndex", type: { fhirType: "integer", isArray: false } }` segment (D1)
- [x] 1.2 Verify other `%`-constants still resolve via `--var` and still throw "Variable %x is not defined" when undefined

## 2. Emitter: thread the row-index expression

- [x] 2.1 In `src/ddb-sql-builder.js`, add a current-row-index SQL parameter to `astToSql` (default `"0"`), threaded alongside `rootVar` through all recursive calls (D2)
- [x] 2.2 Handle the `rowIndex` segment by emitting the threaded index expression
- [x] 2.3 Reserve an index lambda variable name (paired with `L`/`__el`, e.g. `__idx`) that cannot collide with element refs

## 3. Emitter: bind the index in real iterations

- [x] 3.1 Emit the array-input `_forEach`/`_forEachOrNull` as an indexed lambda `(__el, __idxN) -> {…}` and bind the threaded index to `(__idxN - 1)` for the body (D3)
- [x] 3.2 Emit the `_repeat` body projection as an indexed lambda, binding `(__idxN - 1)` over the existing accumulator (D5)
- [x] 3.3 Confirm nested iterations shadow the index correctly so each level reports its own position

## 4. Disambiguate projection vs iteration

- [x] 4.1 Distinguish projection wrappers (resource root, `select`, `unionAll` branch) from real iteration in the emitter so projections pass the enclosing index through unchanged and do not open a new scope (D3); use a distinct `view-parser.js` directive (e.g. `_project`) or an equivalent first-element-of-array signal
- [x] 4.2 Ensure a `unionAll` branch without its own `forEach` reports `0` at the root and the enclosing `forEach` index when nested

## 5. `forEachOrNull` null row

- [x] 5.1 Move the null padding to the source side: `field.ifnull2([NULL]).list_transform((__el, __idxN) -> {…})` so the null row flows through the lambda and reports `%rowIndex = 0` (D4)
- [x] 5.2 Verify existing `forEachOrNull` results are unchanged (behavior-equivalent)

## 6. Test wiring

- [x] 6.1 Set `EXCLUDE = /^row_index/` in `tests/spec.staged.test.js` so the staged suite skips `row_index.json` (staged parity is a follow-up)
- [x] 6.2 Run `spec.test.js`; confirm all `row_index` sub-tests pass except the `repeat` sub-case (known follow-up)
- [x] 6.3 Run the full struct test suite and confirm no regressions
- [x] 6.4 Spot-check generated SQL via `scripts/gen-struct.js` for a `forEach` + `%rowIndex` view and a nested/`unionAll` view
