# On-Demand Typing — re-typing repeat-forced JSON across the boundary

The mechanism that lets flatquack read a field as **raw JSON** in one place and as a
**typed value** in another, within the same query — deciding the typing *on demand* per
navigation rather than once in the read schema. It is what makes a `repeat` (which needs
a raw-JSON view of a recursive field) coexist with typed columns/filters that navigate the
same field, at any depth and any site that crosses the boundary.

Companion to [SPEC_hybrid.md](./SPEC_hybrid.md), which describes the staged emitter and the
`repeat` lowering this builds on.

---

## 1. The tension

flatquack reads FHIR with DuckDB `read_json_auto`, giving each field an explicit SQL type
from the FHIR schema (`id VARCHAR`, `item STRUCT(linkId VARCHAR, …)[]`, …). Typed columns
are fast and clean.

But `repeat` traverses a **recursive** type (`Questionnaire.item` contains `item` contains
`item`…), which cannot be expressed as a *finite* `STRUCT`. So a repeat seed field is
**forced to `JSON[]`** in the read schema:

```
columns={ id: 'VARCHAR', item: 'JSON[]' }     -- `item` forced: a repeat traverses it
```

This splits the world in two:

- the **read schema** says `item` is physically `JSON[]`;
- the **FHIRPath leaf engine** (`src/ddb-sql-builder.js`) is *forced-JSON-blind* — it resolves
  types from the FHIR StructureDefinition, so it still believes `item.linkId` is a `string`
  and assumes the physical type matches the declared type.

When they disagree, a typed column navigating the forced field (`item.linkId.first()`)
physically yields **JSON** (`"g1"`, quoted) while the engine labels it `string`. That either
silently emits a wrong value, or — in a `unionAll`, where `UNION ALL` forces one physical
type across branches — throws `Conversion Error: Malformed JSON`.

## 2. The idea

Rather than make the whole engine JSON-aware, **re-type the forced field back into a typed
`STRUCT` exactly where a navigation crosses the JSON boundary**, with `from_json`:

```sql
item.list_transform(x -> fq_cast_questionnaire_item(x))   -- JSON[]  →  STRUCT(linkId VARCHAR)[]
    .list_transform(el -> el.linkId).slice(1)             -- el.linkId is now VARCHAR
```

where `fq_cast_questionnaire_item(j) AS from_json(j, '{"linkId":"VARCHAR"}')`. After the cast
the rest of the navigation runs on a typed struct, so the engine's assumption becomes **true**.
It is the inline form of the same `from_json` bridge that `repeat`/`forEach` already apply at
the scope level (SPEC_hybrid §5).

The structure types only the **leaves actually navigated** (`linkId`); any *recursive*
sub-part (a nested `item`) stays `JSON[]`, so the finite-STRUCT problem never recurs.

## 3. The four moving parts

**(1) Knowing what is forced — `forcedJsonPaths`** (`src/staged-sql-builder.js`).
As the builder walks the ViewDefinition, every `repeat` seed is recorded as a resource-rooted
path (`item`, `answer.item`, …). This single set drives **both** the read-schema forcing
(`applyForcedJson`, `src/query-builder.js`) **and** the re-type decision — so the two can never
disagree about which fields are physically JSON. `forcedJsonPaths` is the single source of truth.

**(2) Building the cast structure — `forcedFieldStructures`** (`src/repeat-lowering.js`).
For a scope, it parses the columns' paths into a navigation tree, descends to each forced field,
and renders the typed structure of the leaves under it via `pathsToJsonStruct`. Columns
navigating `item.linkId` and `item.maxLength` merge into one `{"linkId":"VARCHAR","maxLength":"INTEGER"}`.

**(3) Pooling the macros — `castMacroFor`** (`src/staged-sql-builder.js`).
Each distinct structure string becomes one `CREATE OR REPLACE MACRO fq_cast_*`. Identical
structures **share** one macro — so a columns-only branch and a `repeat` branch that both need
`{"linkId":"VARCHAR"}` emit a single pooled macro.

**(4) Applying it — the `_retype` channel + the `nav` case** (`src/ddb-sql-builder.js`).
The builder assembles a `_retype` map (`relative path → macro name`) and rides it on the
element's `inputType` when compiling a column. In the leaf engine's `nav` case:

```js
const retypes = inputType._retype;
if (retypes) {
  const castMac = retypes[node.value];
  if (typeof castMac === "string")
    sql = outputType.isArray ? `${sql}.list_transform(x -> ${castMac}(x))` : `${sql}.${castMac}()`;
  // propagate the remainder of each matched path ("answer.item" → "item") onto the
  // navigated outputType, so a deeper segment re-types at its own divergence point
  const descPrefix = node.value + ".";
  const descRetypes = {};
  for (const k in retypes) if (k.startsWith(descPrefix)) descRetypes[k.slice(descPrefix.length)] = retypes[k];
  if (Object.keys(descRetypes).length) outputType = {...outputType, _retype: descRetypes};
}
```

Two subtleties make this precise:

- It rides on `inputType`, which the engine only threads to the **first nav off the element**,
  so deeper segments of a *non-forced* path are never accidentally wrapped.
- The map is keyed by **relative path** and **propagated down** matched segments. For a dotted
  seed like `answer.item`, the cast does **not** fire at `answer` (still typed) — it fires at
  `.item`, the exact depth where physical JSON diverges. A path crossing several forced
  boundaries re-types at each. The method-append form (`<expr>.macro(...)`) composes whether
  the forced field heads the path or sits deeper.
- Nodes that hold sub-expressions thread `inputType` (hence `_retype`) into each: `comparison`
  (`=`, `<`, …), `components` (`and`/`or`/`+`/`-`/`*`), and the **`where` lambda**. So an operand
  or predicate that itself navigates a forced field — `item.maxLength.first() + 1`, or a forced
  field reached first inside the lambda as `where(item.linkId.first() = 'x')` — is re-typed at its
  boundary just like a bare column. The `where` lambda resets the *structural* type (its predicate
  navigates from a fresh `el`) but keeps the `_retype` channel: it passes `{_retype:
  inputType._retype}`, not `{}`. The map's keys are relative to the scope element, which is exactly
  what `el` binds (the singleton, or each array element), so the cast still fires at its divergence
  depth.
  - **Invariant:** any node that holds a sub-expression *and* imposes a SQL type on it must thread
    `_retype`; otherwise that sub-expression binds raw JSON instead of the typed value. The
    structural tell of a thread that is missing is an **orphaned `fq_cast_*` macro** — derived and
    minted from the navigated paths, but never applied at a nav site (guarded by the "no orphaned
    cast macros" shape assertion).

## 4. Where it fires — and where it does not

Applied at the **typed spine** (gated on `schemaPrefix`), where the read schema actually
forces JSON:

- root columns, chain-`forEach` columns (including nested levels) — re-typing is decided
  **per scope**: `emitScope` recurses, recomputing the scope's own forced seeds and `_retype`
  map, so a forced field that a *nested* `repeat` introduces inside a `forEach` body is re-typed
  by that body's columns;
- `unionAll` **columns-only** branches (they share the parent element);
- `where` paths (they evaluate at the resource root — the staged builder hands
  `query-builder` a resource-rooted `whereRetype` map so a `where` that navigates a forced
  field is re-typed exactly like a root column);
- a forced field reached **first inside a `where()` lambda** — `where(item.linkId.first() = 'x')`,
  implicit `$this`, no outer nav — because the lambda preserves the `_retype` channel (§3).

**Not** applied — and not needed — where the element already arrives typed through a
`from_json` bridge:

- `repeat` bodies (the bridge already types the body's navigated leaves);
- a `forEach` whose **own iteration path is the forced field** (routed through `emitJsonEach`,
  which bridges the whole element) — distinct from a `forEach` that merely *contains* a nested
  `repeat`, whose body columns re-type normally (above);
- fork branches (they read pre-materialised typed arrays).

It is a **no-op for non-repeat views**: if nothing is forced, the `_retype` map is `null` and
column compilation is byte-for-byte unchanged. Only the boundary-crossing column is wrapped — a
plain column (e.g. `id`) is untouched.

## 5. End-to-end example

View: a `unionAll` of `{ linkId: item.linkId.first() }` (columns-only) and
`{ repeat: ["item"], linkId }`.

1. The walk records `item` in `forcedJsonPaths` → read schema emits `item: 'JSON[]'`.
2. The columns-only branch navigates `item.linkId` → `forcedFieldStructures` yields
   `{"linkId":"VARCHAR"}` → `castMacroFor` mints `fq_cast_questionnaire_item`.
3. That branch compiles to
   `item.list_transform(x -> fq_cast_questionnaire_item(x)).list_transform(el -> el.linkId).slice(1)`
   → **VARCHAR**.
4. The `repeat` branch descends in JSON, then bridges each node via the **same pooled macro**
   → its `linkId` is also **VARCHAR**.
5. `UNION ALL` reconciles two VARCHAR columns — no JSON cast, no error.

Forcing buys recursion support; on-demand typing buys back correctness everywhere a typed
navigation reaches into the forced region — one `from_json` cast, fired at the precise
divergence point, pooled across every site that needs the same shape.

## 6. Boundaries & related behaviour

- **Recursion truncation.** A navigation two levels deep through one forced field
  (`item.item.linkId`) re-types both levels in the derived structure, because the navigated
  path types each level; a genuinely *recursive* seed (the field re-entering `WITH RECURSIVE`)
  stays raw JSON. The cast is per-element, so unbounded depth is never expanded into a STRUCT.
- **Multiple forced fields at one scope** get distinct macros (different structures); multiple
  `ofType()` choices on one polymorphic element merge into one structure
  (`{"valueDecimal":"DOUBLE","valueDate":"VARCHAR"}`).
- **Orthogonal:** `ofType()` is compiled as a *projection* (`list_transform(el -> el.valueX)`),
  not a filter — identical with or without a boundary. `ofType(date).first()` over a
  mixed-type answer array therefore reflects that pre-existing semantics, independent of
  on-demand typing.

## 7. Source map

| Concern | Location |
|---|---|
| Record forced seed paths; build `_retype` map per scope; pool macros (`castMacroFor`); `where` re-type map | `src/staged-sql-builder.js` |
| Inline re-type at the `nav` case; relative-path propagation; `_retype` on `inputType` | `src/ddb-sql-builder.js` |
| `forcedFieldStructures` (leaf structures under each forced path); `pathsToJsonStruct` | `src/repeat-lowering.js`, `src/ddb-sql-builder.js` |
| `applyForcedJson` (force read-schema nodes to JSON); thread `whereRetype` into `where` SQL | `src/query-builder.js` |

## 8. Tests

- `tests/custom-tests/ondemand_typing.json` — the systematic matrix: context × boundary depth
  (A), one case per boundary-crossing operator (B), `unionAll` branch-kind combinations (C),
  declared-type fidelity (D), probes (G), multiplicity & deep navigation (H).
  - B13/B14 pin the `where()`-lambda first-touch boundary (column-expression and ViewDefinition
    `where`-clause forms): a forced field reached first inside the lambda is re-typed, not bound
    as raw JSON.
- `tests/staged-sql-shape.test.js` — macro-pooling assertions (reuse vs distinct; merged
  structures), no-op invariants (non-repeat → no macro; only the crossing column wrapped), and
  the **no-orphaned-macro** guard (every minted `fq_cast_*` is called — the structural tell of a
  re-type map built but not threaded to its nav site).
- `tests/custom-tests/repeat_extra.json`, `tests/custom-tests/repeat_nested_forced_json.json`
  — single- and multi-segment forced-field navigation by typed columns.
- `tests/spec-tests/repeat.json` → "unionAll with repeat and non-repeat branches" — the
  official conformance case for a `unionAll` of repeat and non-repeat branches over a forced field.
