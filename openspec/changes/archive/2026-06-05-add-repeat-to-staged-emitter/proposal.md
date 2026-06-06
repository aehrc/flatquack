## Why

The staged emitter (`SPEC_hybrid`) is the production-default lowering, but it **rejects
`repeat`** — `assertNoRepeat` throws, and `repeat` views fall back to the slower `struct`
emitter. `repeat` is the one SQL-on-FHIR directive that is *unbounded-depth*
(`QuestionnaireResponse.item.item…`), and that is exactly why it does not fit the emitter's
typed substrate as-is:

- The emitter is **typed**: it reads via `read_json(columns=STRUCT(…))` and the leaf engine
  navigates typed structs. A typed STRUCT cannot be self-referential in DuckDB, so a
  recursive type is inexpressible and would expand forever in `pathsToSchema`.
- A `WITH RECURSIVE` descent requires the carried node column to have **one fixed type**
  across both legs. Navigating into a (necessarily bounded) typed STRUCT yields a
  *shallower* type, so the recursive leg cannot type-match the seed leg. **JSON is the only
  type closed under descent** — which is why every reference query in
  `tests/generated-sql/SPEC_hybrid/repeat.json/` performs the recursion in the JSON binding.

Bounding the type (Pathling-style depth unrolling) was considered and rejected as the
primary mechanism: it caps depth (silently wrong past N — a spec-conformance failure, since
`repeat` is unbounded), it multiplies the emitted SQL, and `SPEC_hybrid` §11 measures the
**typed binding as the cost to *avoid* for `repeat`** (eager nested-`STRUCT[]`
materialisation loses to JSON's lazy pointer-walk).

## What Changes

Add `repeat` support to the staged emitter by letting the binding **oscillate** between
typed and JSON, with the recursion always in JSON and every *semantic* evaluation
(`column`/`forEach`/`where`) still on typed data:

- **Repeat descent in JSON.** A `repeat` lowers to a `WITH RECURSIVE` CTE that descends the
  listed paths with the `fhir_list` fold (`UNNEST(fhir_list(node -> '$.<path>'))`,
  `list_transform(...).flatten()` for multi-step paths, `list_concat` across multiple listed
  paths). This is the **only** raw-JSON traversal. A view containing any `repeat` emits a
  leading `WITH RECURSIVE`.
- **Typed evaluation via a per-repeat-scope lenient transform.** At the scope that consumes a
  repeat's recursive output, the JSON node is converted to a typed element with
  **`from_json(node, '<structure>')`** (NOT `CAST` — `CAST` throws on absent FHIR fields;
  `from_json` NULL-fills them, keeps `JSON[]` subfields raw, and tolerates unmapped keys).
  The existing typed FHIRPath engine then evaluates **all** columns, arbitrary-FHIRPath
  `forEach` seeds, and `where` predicates on that typed element — unchanged.
- **One schema rule feeds both reads.** A single "truncate at a `repeat` seed → `JSON[]`,
  everything else typed" rule (added to the path-walk behind `pathsToSchema`) produces both
  the `read_json` `columns=` schema **and** the `from_json` structure. The forced-JSON seed
  **propagates up** into enclosing structs as a partial `STRUCT(item JSON[], …)`, and a
  **nested** `repeat`'s seed lands as `JSON[]` automatically, so it re-enters `WITH
  RECURSIVE` cleanly. No depth knob.
- **Chain vs fork unchanged.** A lone `repeat` (≤1 fan-out child of its scope) is a CHAIN —
  no key, scalars carried through the recursive CTE. A `repeat` among ≥2 fan-out siblings is
  a FORK branch that carries the fork key and recombines by `JOIN USING (key)`
  (`combined_with_unionAll` → `rid`; `sibling_repeats_inside_forEach` → `(rid, item_ord)`).
- **Remove** the `repeat`-rejection from "Unsupported directives".
- Results SHALL remain multiset-identical to the `struct`-emitter oracle on the official
  `repeat.json` suite.

## Non-goals

- **No Pathling/depth-bounded typed unrolling** of the recursive structure (rejected above).
- **`%rowNumber` over `repeat`** (the path-ordered window of `SPEC_hybrid` §11) — a separate
  follow-up; this change covers the structural lowering only.
- **Non-simple `repeat` paths.** This implementation supports **simple traversal paths
  only** — a listed `repeat` entry must be a dot-separated sequence of element names
  (`item`, `answer.item`, `jurisdiction`). A path using functions, filters, or indexers
  (`where(...)`, `ofType(...)`, `first()`, `[n]`, …) is **not supported** and SHALL be
  rejected with a clear error rather than mis-evaluated. (Every path in the official
  `repeat.json` suite is a simple traversal path.)
- No change to the `struct` emitter, output formats, or external dependencies.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `staged-sql-emitter`: add `repeat` lowering (JSON descent + per-scope `from_json` typed
  evaluation), extend "Typed source CTE" with the truncate-at-repeat-seed schema rule, and
  remove the `repeat` clause of "Unsupported directives".

## Impact

- Code: `src/staged-sql-builder.js` (drop `assertNoRepeat`; classify `repeat` in
  `collectScope`/`subtreeHasFork`; new `WITH RECURSIVE` descent emit + `from_json` scope
  bridge; oscillating binding mode threaded through `emitScope`); `src/ddb-sql-builder.js` /
  `src/view-parser.js` (truncate-at-repeat-seed in the schema walk feeding `pathsToSchema`,
  reused for the `from_json` structure); `scripts/gen-staged.js` template may need the
  `WITH`→`WITH RECURSIVE` lead; a small `fhir_list` macro available to staged output.
- Behaviour: `repeat` views run on the staged backend (currently routed to `struct`);
  results unchanged (oracle-verified). Unbounded depth preserved (no cap).
- Tests: route the official `repeat.json` suite through the staged backend; keep the
  `struct` path as the oracle.
