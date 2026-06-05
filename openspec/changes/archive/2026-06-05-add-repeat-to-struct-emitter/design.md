## Context

The `struct` emitter (`src/view-parser.js` → `src/fhirpath-parser.js` → `src/ddb-sql-builder.js`,
assembled by `src/query-builder.js`) is FlatQuack's default backend and the **oracle** the
`staged` emitter is validated against. It compiles a ViewDefinition in two phases:

1. **Phase 1 (SELECT):** one nested `result` struct built with `list_transform`, where every
   `forEach` becomes a list-valued field.
2. **Phase 2 (FROM):** `CROSS JOIN UNNEST` (or `LEFT JOIN UNNEST` for `forEachOrNull`) over those
   list fields, registered by `parseVd` as `tables` and rendered by `tablesToSql`.

It does **not** implement `repeat`: `parseVd` returns `_col('_rseed', <path>)` for a non-root
`repeat` (surfacing only the seed for the staged schema) and never walks the body, so all 15
`repeat.json` cases fail on `struct`.

The `staged` emitter (archived change `add-repeat-to-staged-emitter`, spec `staged-sql-emitter`)
already solved the *evaluation* problem and defined the **JSON-typed mix** this change reuses:
- A `repeat` seed is read as `JSON[]` (a recursive FHIR type is not a finite STRUCT) — the
  `forceJson` / truncate-at-repeat-seed rule in `pathsToSchema`/`pathsToJsonStruct`, applied via
  `applyForcedJson` in `query-builder.js`.
- The descent navigates JSON with the `fhir_list` fold (`jsonFold` in `staged-sql-builder.js`).
- Each visited JSON node is bridged to a typed element with a lenient `from_json(node,
  '<structure>')` (structure from `pathsToJsonStruct`, truncated at nested-repeat seeds), and the
  existing typed FHIRPath engine compiles every leaf against it (`repeatStructure`, `childElemOf`).

`staged` performs the recursion with `WITH RECURSIVE`. That cannot live inside the `struct`
emitter's single Phase-1 `result` expression. The reduce/accumulator pattern can — verified in
`.local/repeat_view_flatquack_d4_typed_reduce_foreach.sql` and re-probed in-repo on DuckDB 1.5.3.

## Goals / Non-Goals

**Goals:**
- Lower `repeat` on the `struct` backend, multiset-identical to the official `repeat.json`
  oracle and to the `staged` backend on that suite.
- Reuse the staged **JSON-typed mix** verbatim (forced-JSON seed, `fhir_list` descent,
  `from_json` typed bridge, typed leaf evaluation) — including inside a `repeat` region.
- Perform the recursion as a **bounded `list_reduce` accumulator** that composes inside a value
  expression, so `repeat` plugs into the existing two-phase flattener as just another list field.
- Configurable maximum depth (CLI `--repeat-depth`, default 10).
- Extract the reusable repeat helpers into a shared module imported by both emitters, with **no**
  behavior change to `staged`.

**Non-Goals:**
- **Unbounded depth.** The `struct` recursion is depth-bounded by design (see D3). `staged`
  remains the unbounded option.
- **Non-simple `repeat` paths.** Simple dot-separated traversal paths only; functions/filters/
  indexers (`where`/`ofType`/`first()`/`[n]`) are rejected — same limitation as `staged`.
- **`%rowNumber` over `repeat`** — follow-up, as in `staged`.
- Any change to `staged` lowering behavior, output formats, or dependencies.

## Decisions

### D1 — `repeat` is a `forEach` over a reduce-accumulated, bridged list

A `repeat` lowers to a single Phase-1 list field and a `CROSS JOIN UNNEST` table, exactly like a
`forEach`. The only difference is the **source list**: instead of a plain navigation, it is the
recursive accumulation of the listed paths, bridged from JSON to typed elements. Once that typed
list exists, the body (columns + nested `forEach`/`select`/`unionAll`) is compiled by the
existing two-phase machinery, unchanged — body sub-fan-outs register as child tables parented to
the repeat table (`tablesToSql`'s existing `parent` chaining).

Probe-verified Phase-1 expression (DuckDB 1.5.3):

```sql
(list_reduce(
   list_resize([{acc: <SEED>, cur: <SEED>}], <depth>+1),         -- pads with NULLs
   (st, x) -> CASE WHEN len(st.cur) > 0 THEN {
        acc: list_cat(st.acc, <EXPAND(st.cur)>),
        cur:                  <EXPAND(st.cur)>
     } ELSE st END                                                -- empty frontier ⇒ no-op
 )).acc
 .list_transform(rb -> from_json(rb, '<structure>'))             -- JSON → typed el (inline)
 .list_transform(el -> { <body columns> })                       -- existing _forEach body
```

- `<SEED>` = the typed navigation of the listed paths off the enclosing element (`typedSeed`);
  the seed field reads as `JSON[]` because it is forced JSON in the schema.
- `<EXPAND(x)>` = `flatten(list_transform(x, n -> <jsonFold of path>))` concatenated across the
  listed paths with `list_concat` (reuses `jsonFold`).
- `<structure>` = `pathsToJsonStruct` over the body's column/`forEach`/`where` paths, truncated
  at nested-repeat seeds (reuses `repeatStructure`).

**Why reduce over `WITH RECURSIVE`:** the struct emitter has no place to host a top-level
recursive CTE inside its `result` value expression. `list_reduce` is an ordinary scalar
expression, so it composes anywhere — including inside `list_transform` lambdas, which is exactly
how `repeat` inside `forEach` and `repeat` inside `repeat` fall out for free.

**Why this is simpler than `staged`:** the struct emitter's nested-struct + multi-`UNNEST` model
already produces per-parent Cartesian products. Sibling repeats become sibling list fields →
multiple `CROSS JOIN UNNEST` → cross product, with **no** recombination keys and **no** joins —
none of staged's fork/key machinery is needed.

### D2 — Accumulator shape: seed-in-list + `list_resize` padding, fields `acc`/`cur`

DuckDB's 3-arg `list_reduce(list, lambda, initial)` requires the initial accumulator to share the
list's child type (probe: *"initial value type must be the same as the list child type"*), so a
heterogeneous `{acc, cur}` accumulator cannot use it. Instead, seed the accumulator as the first
list element and pad the driver list to the depth with `list_resize([{…}], depth+1)`, which fills
with `NULL` (probed). The fold's `CASE … ELSE st` ignores the padding (the `x` parameter is
unused) and short-circuits once the frontier `cur` is empty.

The accumulator fields are named **`acc`/`cur`, never `all`** — `ALL` is a reserved word and
`<expr>.all` is a parser error in DuckDB 1.5.3 (the `.local` reference's `'all'` would fail too).

### D3 — Bounded depth, configurable, default 10

The accumulator runs a fixed number of steps (`depth`), so descendants deeper than `depth` are
omitted. This is the deliberate trade for fitting the value-expression model. Mitigations:
- `list_resize` keeps the emitted SQL **constant-size** at any depth, so a generous bound is free
  in SQL size; only runtime pays ~`depth` cheap no-op iterations per row once the frontier empties.
- Default **10** comfortably exceeds realistic `QuestionnaireResponse` nesting (typically 5–6).
- CLI `--repeat-depth` overrides it, threaded through `templateToQuery`/`buildQuery` to the
  emitter. The depth is a compile-time constant baked into `list_resize`.

This is the one behavioral divergence from `staged` (unbounded); called out in the spec and the
proposal so it is an explicit, documented limitation rather than a silent surprise.

### D4 — Body re-rooted at the repeat element type (schema-aware orchestration)

The seed field is `JSON[]` at the source, but the body must be typed against the real element
type (e.g. `QuestionnaireResponse.item`). So the body cannot be a sub-expression of the
forced-JSON seed nav in a single compile — it must be **re-rooted** at the repeat element's
`schemaPath` and compiled against the bridged `el` (the same move `staged` makes via
`childElemOf` + a recompile rooted at `type.schemaPath`). Because this needs the FHIR schema, the
repeat lowering is orchestrated where schema is available (`query-builder.js` / the shared module
calling `fhirpathToAst`), then the reduce+bridge wrapper is emitted around the body and the body's
sub-fan-out tables are registered. `astToSql` stays schema-free.

### D5 — Inline `from_json` bridge, no cast macro

`staged` factors each `from_json` structure into a `fq_cast_*` macro because the bridge recurs at
every CTE scope and depth. In the reduce form the bridge appears at exactly **one** call site per
`repeat` (the single `list_transform(rb -> from_json(rb, …))`), so it is inlined. No macro
plumbing is added to the `struct` template; the existing `fhir_list` macro (already in
`templates/duck-macros.js`) is reused for the descent.

### D6 — Extract shared helpers into `src/repeat-lowering.js`

`assertSimplePath`, `jsonFold`, `typedSeed`, `repeatStructure`, and `childElemOf` are currently
private to `staged-sql-builder.js` but are backend-agnostic. Move them to a new
`src/repeat-lowering.js` and import from both emitters. `typedSeed`/`repeatStructure` close over
`makeBuilder` (compile/arrayize) and `schema`/`vars`; the extraction passes those in as
parameters (or a small builder handle) so neither emitter changes behavior. The `staged` suite is
the regression guard that the refactor is behavior-preserving.

### D7 — `parseVd` emits a `_repeat` fan-out on the struct path

`parseVd`'s current `if (node.repeat && !isRoot) return _col('_rseed', …)` is the staged-schema
shim. On the struct path it is replaced by: register a flattening table (reuse the `each`/`union`
table mechanism so `tablesToSql` cross-joins it) and emit a `_repeat` directive carrying the
listed paths and the walked body, so the body's sub-fan-outs (nested `forEach`/`select`) chain as
child tables. The seed fields are still forced to `JSON[]` in the read schema via
`applyForcedJson` (now driven for the `struct` backend, not only `staged`).

## Risks / Trade-offs

- **Depth cap silently truncates very deep data (D3).** → Default 10 exceeds realistic nesting;
  `--repeat-depth` overrides; the limitation is documented in the spec and proposal. A deep-nesting
  test fixture asserts both full coverage below the cap and truncation at it.
- **`from_json` structure must match the engine's navigation** (choice-type `valueX` naming, e.g.
  `value.ofType(string)` → `el.valueString`). → Both derive from the same FHIR schema via
  `pathsToJsonStruct`; mirror the staged `tests/staged-repeat.test.js` choice-type case on struct.
- **Helper extraction could perturb `staged`** (D6). → Pure move + parameterize; the full staged
  `repeat.json` suite (both rootKey modes) and `tests/staged-repeat.test.js` must stay green.
- **Reserved-word / lambda-collision footguns.** → `acc`/`cur` not `all` (D2); the bridge lambda
  var (`rb`) is distinct from the body lambda var (`__el`/`L`) so the two `list_transform`s do not
  shadow — the same class of bug fixed for staged in commit `1a8ccb7`. A struct collision test
  (column navigating an array inside a repeat) guards it.
- **Per-row no-op iterations** (`depth` steps even on shallow data). → Cheap (`len` check + early
  return); benchmark on the existing harness if depth is raised substantially.

## Open Questions

- None blocking. Whether to *also* route the official `repeat.json` suite through `struct` as a
  permanent CI cross-check (vs. keeping `staged` as the sole runner) is a test-wiring choice
  settled in tasks — the intent is that both backends run the suite and are diffed against each
  other.
