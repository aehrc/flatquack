## 1. Key-mode plumbing

- [x] 1.1 Add a `rootKey` option (`"natural" | "uuid"`, default `"natural"`) to
  `buildStagedQuery(vd, schema, vars, opts)` in `src/staged-sql-builder.js`.
- [x] 1.2 Thread the option through `buildQuery` and `templateToQuery` in
  `src/query-builder.js` (alongside the existing `backend` arg).
- [x] 1.3 Surface it on the CLI in `src/cli.js` (e.g. `--root-key natural|uuid`, default
  `natural`) and pass it into `templateToQuery`.

## 2. Natural-key default (replace the row_number window)

- [x] 2.1 In `emitScope`, replace the root-key projection
  `k === "rid" ? "row_number() OVER () AS rid"` so that, in `"natural"` mode, the root
  `rid` column is the resource key expression (`getResourceKey()` / resource `id`) compiled
  via the leaf binding, aliased `AS rid`.
- [x] 2.2 Ensure the resource-key path is present in the typed `columns=` read schema.
  The schema is aggregated from the ViewDefinition's own paths; the natural key compiles
  `getResourceKey()`/`id`, which a view need not otherwise reference. When `"natural"` mode
  keys a root (or nested-enclosing) fork, add the resource-key AST to the set fed to
  `extractPathsFromAst`/`pathsToSchema` so `id` is read. Only add it when a fork actually
  needs the natural key (lazy — no schema change for chain-only views or `"uuid"` mode).
- [x] 2.3 Confirm no `row_number() OVER ()` is emitted for any root fork in `"natural"` mode.
- [x] 2.4 Confirm nested forks still build the composite `(rid, ord_i)` key, now seeded by
  the natural `rid`.

## 3. Opt-in uuid key

- [x] 3.1 In `"uuid"` mode, project the root `rid` as `uuid() AS rid`.
- [x] 3.2 Make `buildStagedQuery` signal that `src` must be materialised in `"uuid"` mode
  (e.g. return a `srcMaterialized` flag), and have the consuming templates emit
  `WITH src AS MATERIALIZED (...)` accordingly (`tests/test-util.js` stagedQueryTemplate and
  any CLI/benchmark template).
- [x] 3.3 Verify the volatile `uuid()` is evaluated exactly once per resource (both branches
  carry the same value).

## 4. Verification

- [x] 4.1 Run the staged spec-test harness (`tests/spec.staged.test.js`) — must stay green in
  both modes.
- [x] 4.2 Add a root-fork multiset-identity test: generated SQL (each mode) `EXCEPT ALL` the
  `struct`-emitter oracle = 0 both directions, on DuckDB 1.4.1 and 1.5.2.
- [x] 4.2a Add a root-fork view that projects **no `id` column** (e.g. two sibling `forEach`
  with non-id columns) and confirm `"natural"` mode still reads `id`, joins correctly, and
  does not leak `id`/`rid` into the output.
- [ ] 4.3 Regenerate the benchmark hybrid-typed SQL for `sibling_foreach_view` and confirm
  the timing: natural ≈ 1.1 s / 0.7 s, uuid ≈ 1.3 s / 1.3 s, vs the old 3.4 s window.

## 5. Docs

- [ ] 5.1 Note the default/opt-in key choice and the id-uniqueness assumption in
  `specs/SPEC_hybrid.md` §4 (the fork key section) and/or `benchmark/hybrid_vs_baseline.md`.

> **Deferred (4.3, 5.1):** These two tasks target artifacts that do not exist in this
> worktree — there is no `benchmark/` directory, no `sibling_foreach_view` ViewDefinition,
> no benchmark dataset, and no `specs/SPEC_hybrid.md`. The code is ready for 4.3
> (`bun scripts/gen-staged.js <view.json> <out.sql> [natural|uuid]`); both tasks should be
> completed in the worktree/branch that holds the benchmark harness and the hybrid spec doc.
