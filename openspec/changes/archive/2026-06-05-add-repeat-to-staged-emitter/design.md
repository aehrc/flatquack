## Context

The staged emitter (`src/staged-sql-builder.js`, spec `staged-sql-emitter`,
`specs/SPEC_hybrid.md`) walks the ViewDefinition tree, classifies each scope CHAIN/FORK, and
emits staged CTEs. Every leaf (column path, `forEach` array path, `where` predicate) is
compiled by the **typed** FHIRPath engine (`fhirpathToAst` + `astToSql`) against
`schemas/fhir-schema-r4.json`, and the source is read with a typed `read_json(columns=…)`
schema built by `extractPathsFromAst` + `pathsToSchema`. It currently throws on `repeat`
(`assertNoRepeat`).

`repeat` is unbounded-depth, which collides with the typed substrate in two ways
(both verified):

1. **A recursive type is inexpressible.** `pathsToSchema` over `item.item…` never
   terminates; DuckDB STRUCTs are not self-referential.
2. **`WITH RECURSIVE` needs a fixed carried type.** Navigating into a bounded typed STRUCT
   yields a shallower type, so the recursive leg cannot type-match the seed leg. JSON is the
   only type closed under descent.

This is why every `tests/generated-sql/SPEC_hybrid/repeat.json/` reference performs the
recursion in the JSON binding. This change adopts that — recursion in JSON — while keeping
*semantic* evaluation typed, so arbitrary-FHIRPath `forEach`/`column`/`where` still run on
the existing engine.

DuckDB conversion semantics were probed before this design (see D4).

## Goals / Non-Goals

**Goals:**
- Lower `repeat` (chain and fork; nested; beside `forEach`/`forEachOrNull`/`unionAll`;
  multi-step and multiple listed paths) on the staged backend, multiset-identical to the
  `struct` oracle on the official `repeat.json` suite.
- Keep every `column`/`forEach`/`where` evaluation on the **typed** engine, unchanged —
  including inside a `repeat` region — so arbitrary FHIRPath keeps working.
- Preserve **unbounded** depth (no cap) and the lazy-key discipline.
- One schema rule serving both the source read and the per-scope transform.

**Non-Goals:**
- Pathling/depth-bounded typed unrolling (rejected — D0).
- `%rowNumber` over `repeat` (follow-up).
- Non-simple `repeat` paths. **Limitation:** this implementation supports **simple traversal
  paths only** (dot-separated element names). A listed path using functions/filters/indexers
  (`where`, `ofType`, `first()`, `[n]`) is rejected with a clear error.
- Struct-emitter, output-format, or dependency changes.

## Decisions

### D0 — Recurse in JSON; reject depth-bounded typed unrolling

Two coherent designs exist, forced by the type system: (J) recurse with `WITH RECURSIVE`
over a JSON node — unbounded, spec-correct; or (U) statically unroll the descent to depth N
over a bounded typed STRUCT. (U) caps depth (silently wrong past N — `repeat` is unbounded),
multiplies emitted SQL N×, and `SPEC_hybrid` §11 measures the **typed binding as the cost to
avoid for `repeat`** (eager nested-`STRUCT[]` materialisation loses to JSON's lazy
pointer-walk). We adopt (J). Typed performance is recovered *only where it is cheap* — at the
leaf, via D5 — not by typing the recursive structure.

### D1 — JSON descent (the only raw-JSON traversal)

A `repeat` lowers to a `WITH RECURSIVE` CTE whose seed is the listed paths off the enclosing
node and whose recursive leg re-applies the same paths to each visited node, **excluding the
seed** (SQL-on-FHIR `repeat` semantics). Path folding (`SPEC_hybrid` §5):
- single step `item` → `UNNEST(fhir_list(node -> '$.item'))`
- multi-step `answer.item` →
  `list_transform(fhir_list(node -> '$.answer'), x -> fhir_list(x -> '$.item')).flatten()`
- multiple listed paths → `list_concat(<fold p1>, <fold p2>, …)`

A view containing any `repeat` emits a **leading `WITH RECURSIVE`** (a recursive CTE under
plain `WITH` is a Catalog Error — `SPEC_hybrid` §5 mechanic 1). Non-recursive CTEs mix freely
under it. A `fhir_list` macro is made available to staged output.

*The descent reads JSON, never the typed `read_json` columns* — the recursive output is a
heterogeneous-depth JSON node, so the seed field must be JSON at its source (D3).

### D2 — Oscillating binding mode (not monotone contagion)

Each scope carries a binding mode: `typed` (today's behaviour — element is a `read_json`
column) or `json` (element is a JSON node). The mode **flips per boundary**, it does not
spread monotonically:

```
root              typed
  repeat item     → JSON descent (D1)
    scope         from_json(node) → typed el (D5) → typed columns + forEach
      forEach …   inherits el's typed sub-struct → typed (arbitrary FHIRPath OK)
        repeat    el.<field> is JSON[] (D3) → JSON descent again
```

`forEach` always re-establishes typed evaluation (it is arbitrary FHIRPath and must use the
engine); `repeat` always drops to JSON for its descent. The emitter threads the mode through
`emitScope`; `typed` scopes are byte-for-byte unchanged.

### D3 — One schema rule: truncate at a repeat seed → `JSON[]`, propagate up

A single rule, added to the path-walk feeding `pathsToSchema`: when building a typed STRUCT
over the needed paths, wherever a field is the **seed of a `repeat`**, emit `JSON[]` and stop
descending; everything else stays typed. Applied at arbitrary depth, the forced-JSON seed
**propagates up** into enclosing structs as a partial `STRUCT(item JSON[], …)`. The same rule
and the same `pathsToSchema` output (the `{name: 'TYPE'}` structure format) serve **both**:

```
            pathsToSchema  (+ truncate-at-repeat-seed)
                  │
       ┌──────────┴───────────┐
       ▼                       ▼
 read_json(columns={…})   from_json(node, '{…}')   (D5)
 the SOURCE read          the PER-REPEAT-SCOPE transform
 (partial typed struct)   (nested repeat seed → JSON[] → re-descends)
```

This makes a nested `repeat`'s seed land as `JSON[]` *for free* (D5), and removes any need
for a depth knob — the boundary is "at a repeat", not "at depth N".

### D4 — Lenient `from_json`, not strict `CAST` (probed)

The per-scope JSON→typed conversion (D5) must tolerate FHIR's routinely-absent fields and
keep nested-repeat seeds raw. DuckDB 1.5.2 probe:

| variant | missing field | sub-array as raw `JSON[]` | unmapped key | scalar type mismatch |
|---|---|---|---|---|
| `CAST(json AS STRUCT(…))` | **throws** `does not have key` | — | — | — |
| `from_json` / `json_transform` | NULL-fills | kept raw | dropped | lenient (NULL) |

So the conversion is **`from_json(node, '<structure>')`** (≡ `json_transform`; `_strict`
variants throw). Declaring a field `JSON[]` in the structure keeps it raw — the mechanism by
which a nested repeat's seed survives the transform and re-enters `WITH RECURSIVE`.

### D5 — Per-repeat-scope typed bridge

At the scope consuming a repeat's recursive output, emit
`from_json(node, '<structure>') AS el`, where `<structure>` is the D3 `pathsToSchema` over
that scope's needed paths (its column paths ∪ `forEach` seed paths ∪ `where` paths,
truncated at nested repeats). The existing leaf engine then compiles every column / `forEach`
seed / `where` against `el` exactly as in a typed scope (reuse D2 of the prior change — the
configurable outer root-var; the scope element is aliased and passed as the engine's root).
The bridge struct is **always finite**: column/`forEach`/`where` FHIRPaths never recurse;
only the `repeat` *directive* recurses, and it is the one field left as `JSON[]`. The
verbose `from_json(node, '<structure>')` literal is factored into a named macro per distinct
structure (D8).

### D6 — Chain vs fork for `repeat` (reuse the existing classifier)

`collectScope` classifies a `repeat` child as a fan-out (`type: "repeat"`); `subtreeHasFork`
counts it. Then:
- **Lone `repeat` (CHAIN)** — no key. Carry the enclosing scope's already-projected typed
  scalars *into and through* the recursive CTE; continue `emitScope` on the repeat's child
  select with the recursion output as parent stage (`json` mode). (`basic`, `combined_with_*`,
  `repeat_inside_*`, triple-nesting refs.)
- **`repeat` among ≥2 fan-out siblings (FORK)** — the repeat branch carries the fork key and
  recombines by `JOIN USING (key)` like any branch: root fork → `rid`
  (`combined_with_unionAll`); nested fork → `(rid, ord_i)`
  (`sibling_repeats_inside_forEach` keys `(rid, item_ord)`). A `unionAll` whose branches are
  repeats unions the keyed branches.

A `forEach` spine that feeds downstream repeats may carry the JSON node one level as a column
(`item_node` in `sibling_repeats_inside_forEach`) — a bounded, deliberate relaxation of
`SPEC_hybrid` Discipline 2, consumed immediately by the sibling repeats.

### D7 — Top-level `WITH RECURSIVE` lead

When the VD contains any `repeat`, the assembled query leads with `WITH RECURSIVE` instead of
`WITH`. The staged core already returns the CTE list + final `SELECT`; the lead keyword
becomes conditional on "VD has a repeat" (`scripts/gen-staged.js` template / the staged
assembly in `query-builder.js`).

### D8 — Factor each cast into a named macro (verbosity)

A D5 `from_json` structure mirrors the typed schema down to its truncation point, so an
inlined literal can be hundreds of characters and would repeat at every scope. Factor each
**distinct** structure into a scalar macro defined in the preamble (beside `fhir_list`, where
`scripts/gen-staged.js` already prepends macros):

```sql
CREATE OR REPLACE MACRO fq_cast_qr_item(j) AS from_json(j,
  '{"linkId":"VARCHAR","text":"VARCHAR","item":"JSON[]"}');
-- call site (D5):  fq_cast_qr_item(node) AS el
```

DuckDB 1.5.2 probes fix the shape (the alternatives are dead ends):
- `from_json` inside a `CREATE MACRO` **preserves return-type inference** and field access
  (`fq_cast_x(j).linkId` binds) — so the macro is a transparent stand-in for the inline call.
- `from_json` does **not** accept a named `TYPE` as its structure argument (`Binder Error`),
  and `CAST(json AS named_type)` still **throws** on absent keys — so the structure must be a
  string literal and the conversion must stay `from_json`. A macro is the only viable
  factoring of the cast.
- The emitter keeps a `structure-string → macro-name` map and emits each macro **once**;
  identical structures across scopes share one macro. A `repeat` revisits a single canonical
  type (every `item` node has the same shape), so its descent scope uses **one** macro at all
  depths. Names derive from the scope `schemaPath` (`fq_cast_qr_item`) with an index fallback
  (`fq_cast_3`); `CREATE OR REPLACE` keeps it idempotent across a reused connection.

*Optional, separate:* the `read_json` `columns=` schema can likewise be shrunk with named
`CREATE TYPE`s (probe (c): `columns={item: 'item_t[]'}` works and stays lenient). This does
**not** unify with the cast (types can't feed `from_json`), so treat it as an independent
nicety, not part of the cast-macro mechanism.

This is a pure factoring of D5 — no change to observable output — so it carries no spec
scenario.

## Risks / Trade-offs

- **`from_json` structure must match the engine's navigation.** The engine emits `el.linkId`
  / `el.valueCoding` for `value.ofType(Coding)`; the `from_json` structure must name exactly
  those fields. Both derive from the same FHIR schema via `pathsToSchema`, so they align —
  but choice-type field naming (`valueX`) is the spot to test first.
- **JSON node carried through a `forEach` fan-out** (D6) duplicates the node per produced row
  — bounded to one level and consumed by the next stage; acceptable per the references, but
  worth a glance on wide nodes.
- **Two reads of the same field in two representations** (a `repeat` and a sibling `forEach`
  sharing a field): the field is `JSON[]` at source (repeat wins — typed would be infinite),
  and the `forEach` consumes it via the D5 bridge. Verify the shared-field case
  (`top-level_repeat_with_sibling_forEach`).
- **Simple traversal paths only (limitation).** The descent fold (D1) handles dot-separated
  element navigation. A listed `repeat` path using functions/filters/indexers
  (`where`/`ofType`/`first()`/`[n]`) is detected and rejected with a clear error rather than
  silently mis-folded; the per-step typed-descent that would support it is deferred.
- **`WITH RECURSIVE` lead is global** — a single recursive CTE anywhere forces the keyword;
  harmless for non-recursive CTEs but must be emitted exactly once at the top.
- **Engine reuse on a `from_json` element** is the central bet; if a leaf shape resists the
  bridge, fall back to JSON-accessor leaves (`node ->> '$.path'`) for that leaf only — but
  the goal is zero new JSON leaf machinery beyond the D1 descent fold.
