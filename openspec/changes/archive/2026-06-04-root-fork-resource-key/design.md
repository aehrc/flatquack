## Context

`buildStagedQuery` (`src/staged-sql-builder.js`) classifies each `select` scope as a CHAIN
(≤1 fan-out child) or a FORK (≥2). At a FORK each branch is computed as its own staged
sub-chain carrying a recombination key, then joined. The key is generated lazily: only on
spines that reach a fork. At a **root** fork the key today is minted in `emitScope` as:

```js
keyProj = isRoot ? keyCols.map(k => k === "rid" ? "row_number() OVER () AS rid" : k) : keyCols;
```

i.e. a synthetic `rid = row_number() OVER ()`. Both branches read `src` and recombine on
`rid`. Because the branches reference `src` three times (branch a, branch b, and the base
that carries non-key columns), `src` is materialised, and the `row_number()` window — a
DuckDB *blocking* operator — buffers the entire (fat, typed-array-carrying) `src` relation
single-threaded before any fan-out. Measured cost on `sibling_foreach_view` (15.6M rows):
3.47 s / 3.36 s on DuckDB 1.4.1 / 1.5.2.

Investigation results (best-of-3 wall seconds, all verified multiset-identical to the
`struct`-emitter oracle on both engines):

| root-fork key | 1.4 | 1.5 | unique by construction | needs data assumption |
|---|---|---|---|---|
| `row_number() OVER ()` (current) | 3.47 | 3.36 | yes | no |
| temp-table `rowid` | 3.36 | 3.23 | yes (within txn) | no — but no faster |
| `hash(item)` | 113.5 | — | no (collisions) | — |
| natural resource `id` | **1.09** | **0.72** | no | yes (id unique + non-null) |
| `uuid()` + `AS MATERIALIZED` | 1.29 | 1.29 | yes (122-bit) | no |

DuckDB exposes no cheap row index for a JSON table-function scan (`read_json_auto` has no
`file_row_number` option and no `rowid` pseudocolumn — `rowid` exists only after
materialising to a table, and materialising just relocates the same blocking cost).

## Goals / Non-Goals

**Goals:**
- Remove the always-on blocking `row_number()` window at root forks.
- Default to the fastest, semantically-correct key: the natural resource key.
- Offer a correct-by-construction fallback (`uuid()`) for inputs that violate id-uniqueness.
- Keep all outputs multiset-identical to the `struct` emitter; keys never leak into output.

**Non-Goals:**
- Changing nested-fork keying beyond which resource key seeds the composite `(rid, ord_i)`.
- Changing CHAIN lowering, `repeat`, or `%rowNumber`.
- Inventing a synthetic per-scan row id (none exists cheaply in DuckDB — established above).

## Decisions

**Decision 1 — Default key = natural resource key (`getResourceKey()` / `id`).**
Rationale: it is the resource's identity in SQL-on-FHIR (so semantically the right join key),
it is deterministic (lets the optimizer avoid a blocking
window and pick the cheapest plan), and it is the fastest measured option (1.09 / 0.72). It
matches the hand-written reference (`sibling_foreach_hybrid_typed.sql`, which joins on
`response_id`). Alternative considered: keep `row_number()` as default — rejected, 2.6×
slower for a guarantee the data already provides.

*Schema inclusion (corollary of Decision 1).* The typed `columns=` read schema is aggregated
from the ViewDefinition's own paths, but the natural key compiles `getResourceKey()`/`id`,
which a view need not otherwise reference. So when `"natural"` mode keys a fork, the emitter
MUST add the resource-key path to the set fed to `extractPathsFromAst`/`pathsToSchema`,
otherwise `id` is absent from the read and `rid` binds to nothing. This is lazy — added only
when a fork actually needs the natural key (chain-only views and `"uuid"` mode add nothing).
The `id` value stays internal `rid` bookkeeping and never reaches the output projection.

**Decision 2 — Opt-in key = `uuid()` with `src AS MATERIALIZED`.**
Rationale: `uuid()` is a scalar function evaluated in the parallel projection (no blocking
operator), unique by construction (122 random bits; collision prob ~1e-19 at 1e9 rows), and
requires no assumption about the input. The single caveat is that `uuid()` is volatile, so
correctness depends on `src` being evaluated exactly once — otherwise the two branches get
different keys and the join collapses. `AS MATERIALIZED` makes single evaluation explicit and
robust across planner/engine versions (measured free: 1.29 vs 1.29). Alternatives considered:
`hash(node)` — rejected (collisions are unsafe for a key; 113 s on fat structs); temp-table
`rowid` — rejected (no faster than the window, and `rowid` is "strongly advised against as an
identifier" per DuckDB docs, stable only within a transaction).

**Decision 3 — Selection mechanism.** Thread a key-mode option
(`rootKey: "natural" | "uuid"`, default `"natural"`) from `buildStagedQuery` through
`buildQuery`/`templateToQuery`, and surface it on the CLI (e.g. `--root-key uuid`). The mode
only affects scopes whose fork key resolves to the root resource key; CHAIN-only views and
nested-only forks are unaffected except that the resource component of a nested composite key
uses the chosen mode.

## Risks / Trade-offs

- **[Default natural key is wrong when resource ids are duplicated or null]** → A duplicate id
  cross-products the branches of the colliding resources; a null id drops those rows. This is
  the same assumption the SQL-on-FHIR `getResourceKey()` model already makes. Mitigation: the
  `uuid()` opt-in is correct for any input; document the assumption; consider a future
  validation/guard that warns on non-unique ids.
- **[`uuid()` correctness hinges on single evaluation]** → If a future planner ignored the
  CTE boundary the branches would diverge. Mitigation: `AS MATERIALIZED` forces single
  evaluation by contract; covered by a multiset-identity test on both engines.
- **[Behaviour change for existing root-fork views]** → Output values are unchanged for
  unique/non-null ids (the common case); only the generated SQL shape changes. Callers
  depending on guaranteed-correct keys for messy inputs must pass `--root-key uuid`.

## Migration Plan

1. Implement the default natural-key path and the `uuid()` opt-in behind the key-mode option.
2. Run the existing staged spec-test harness (must stay green) plus a root-fork
   multiset-identity check for both modes on both engines.
3. Regenerate the benchmark hybrid-typed SQL; confirm `sibling_foreach_view` drops to
   ~1.1 s / ~0.7 s (natural) and ~1.3 s (uuid). Rollback = revert to the `row_number()`
   projection (single-line change), no data migration.

## Open Questions

- Should the natural-key default fall back to `uuid()` automatically when the root key column
  is absent/nullable in the typed schema, or always require the explicit opt-in? (Leaning
  explicit, to keep behaviour predictable.)
