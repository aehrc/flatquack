## Why

The staged emitter recombines independent fan-out branches at a fork by joining on a
recombination key. At a **root** fork it currently synthesises that key with
`row_number() OVER () AS rid` — a *blocking* window operator (per DuckDB's docs it must
buffer its entire input single-threaded). That serialises materialisation of the `src`
CTE, which carries the full (fat) typed `item` arrays. Measured on `sibling_foreach_view`
(15.6M rows, DuckDB 1.4.1 / 1.5.2): **3.47 s / 3.36 s**, roughly **2.6× slower** than
keying on a value the data already provides. The window buys guaranteed uniqueness, but at
a root fork the resource's own identity already *is* the natural, semantically-correct key.

## What Changes

- At a **root** fork the emitter SHALL default to the **natural resource key**
  (`getResourceKey()` / the resource `id`) as the recombination key, instead of a
  synthesised `row_number()` column. Measured **1.09 s / 0.72 s** — fastest of all options,
  and the semantically correct identity in SQL-on-FHIR.
- Add an **opt-in** `uuid()`-based key (paired with `src AS MATERIALIZED` so the volatile
  `uuid()` is evaluated exactly once and both branches see the same value) for inputs where
  resource-`id` uniqueness/non-nullness cannot be assumed (concatenated exports, deduped
  feeds). Unique by construction (122 random bits), no data assumption; measured
  **1.29 s / 1.29 s**.
- **Remove** the always-on `row_number() OVER ()` root key. (It survives only as the
  mechanism behind the opt-in path is `uuid()`, not `row_number()`.)
- **No change** to nested forks: they keep the composite `(rid, ord_i)` key, where the
  enclosing scope's resource key now follows the same default/opt-in choice.
- All variants remain multiset-identical to the `struct`-emitter oracle (verified on
  both engines).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `staged-sql-emitter`: the "Fork scope keyed recombination" requirement is refined to
  specify *how* the root resource key is generated (natural key default; `uuid()` opt-in;
  no `row_number()` window).

## Impact

- Code: `src/staged-sql-builder.js` (the `emitScope` root-key projection — currently
  `row_number() OVER () AS rid`); a new opt-in flag threaded from `buildStagedQuery` /
  `templateToQuery` (and surfaced on the CLI).
- Behaviour: the default output for views with a root fork changes shape (natural key join);
  results are unchanged for inputs with unique, non-null resource ids — which is the
  SQL-on-FHIR norm. Inputs with duplicate/null ids require the opt-in `uuid()` key for
  correctness (previously correct-by-default via the window).
- Docs/benchmarks: `benchmark/hybrid_vs_baseline.md` and the session investigation hold the
  supporting measurements.
