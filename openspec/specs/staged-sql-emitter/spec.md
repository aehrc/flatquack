# staged-sql-emitter

## Purpose

Defines a `staged` SQL backend for the query builder that lowers a ViewDefinition into a
composition of staged CTEs, as an alternative to the existing `struct` emitter while
producing equivalent result rows.
## Requirements
### Requirement: Backend selection

The query builder SHALL accept a backend selector with values `staged` and `struct`.
When `staged` is selected, query generation SHALL use the staged-CTE emitter defined by
this capability. When no backend is selected, the existing `struct` emitter SHALL remain
the behavior, so existing callers are unaffected.

#### Scenario: Staged backend selected
- **WHEN** a caller builds a query for a ViewDefinition with backend `staged`
- **THEN** the generated SQL is a single `[WITH …] SELECT …` core composed of staged CTEs
- **AND** it produces the same result rows as the `struct` backend for the same ViewDefinition

#### Scenario: Default backend unchanged
- **WHEN** a caller builds a query without specifying a backend
- **THEN** the `struct` emitter is used and its output is unchanged

### Requirement: Typed source CTE with resource and where filtering

The staged emitter SHALL read resources through the existing typed source mechanism
(`read_json_auto`/`source()` with a `columns=` schema) in a first CTE, and SHALL apply the
resource-type filter and any `where` predicates on that source. The `columns=` schema SHALL
cover every path referenced anywhere in the ViewDefinition (all column paths, all forEach
array paths, and all `where` predicates), compiled by the existing schema machinery.

The schema walk SHALL apply a **truncate-at-repeat-seed** rule: wherever a field is the seed
of a `repeat`, the schema SHALL emit that field as `JSON[]` and SHALL NOT descend into it
(a recursive FHIR type is not expressible as a finite typed STRUCT). This truncation SHALL
propagate up through enclosing structs as a partial `STRUCT(<typed fields…>, <seed> JSON[])`,
so that any field on a path leading to a `repeat` seed is read as JSON while its sibling
fields remain typed.

#### Scenario: Resource filtering
- **WHEN** a ViewDefinition declares `resource: "Patient"` with resource filtering enabled
- **THEN** the source CTE restricts rows to `resourceType = 'Patient'`

#### Scenario: Where predicate applied at the source
- **WHEN** a ViewDefinition declares a `where` predicate that must yield a boolean
- **THEN** the predicate is evaluated on the source CTE and rows failing it are excluded
- **AND** a `where` path that does not yield a boolean is rejected with an error

#### Scenario: Repeat seed read as JSON
- **WHEN** a ViewDefinition contains a `repeat` whose seed field is read from the source
- **THEN** that field appears in the `columns=` schema as `JSON[]` (not a recursive STRUCT)
- **AND** sibling fields on the same struct remain typed
- **AND** the schema walk terminates (no unbounded recursion)

### Requirement: Column projection

The staged emitter SHALL project each `column` at the scope that owns it, using the existing
typed FHIRPath leaf engine. A `column` without `collection: true` SHALL produce a single
scalar value (empty yields `NULL`, never an empty array); a `column` with `collection: true`
SHALL produce the collection as an array. Output column names SHALL match the ViewDefinition
column `name`.

#### Scenario: Scalar column
- **WHEN** a column has a path that resolves to at most one value and `collection` is unset
- **THEN** the projected value is that scalar or `NULL`

#### Scenario: Collection column
- **WHEN** a column sets `collection: true`
- **THEN** the projected value is an array containing every value the path resolves to

#### Scenario: Scalar column over a multi-valued path
- **WHEN** a scalar column's path resolves to more than one value at runtime
- **THEN** generation/execution reports an error consistent with the existing emitter

### Requirement: Chain scope lowering

When a `select` scope has at most one fan-out child, the staged emitter SHALL lower it as a
carry-forward chain: the parent stage materialises the child's array as a named column, and
the child stage `UNNEST`s that column. No recombination key SHALL be generated for a scope
that is part of a pure chain.

#### Scenario: forEach is INNER
- **WHEN** a scope has a single `forEach` child over an array
- **THEN** rows are produced per array element (cross product with the parent scope's columns)
- **AND** a parent whose array is empty produces no rows for that branch

#### Scenario: Nested forEach chains
- **WHEN** a `forEach` contains a nested `forEach` (each scope with one fan-out child)
- **THEN** the stages chain so each level unnests the array materialised by the level above
- **AND** the result is the per-level cross product with no recombination join

#### Scenario: Nested select without fan-out
- **WHEN** a scope contains a nested `select` that only adds columns
- **THEN** those columns are projected into the same stage without an extra fan-out

### Requirement: forEachOrNull preserves a null row

The staged emitter SHALL lower `forEachOrNull` so that an empty source collection yields
exactly one row in which the branch's columns are `NULL`, while a non-empty collection
behaves like `forEach`. The null row SHALL be produced without losing the parent scope's
columns.

#### Scenario: Empty collection yields one null row
- **WHEN** a `forEachOrNull` iterates a collection that is empty for a given parent
- **THEN** one row is produced for that parent with the branch's columns set to `NULL`

#### Scenario: Non-empty collection behaves like forEach
- **WHEN** a `forEachOrNull` iterates a non-empty collection
- **THEN** it produces one row per element, identically to `forEach`

### Requirement: Fork scope keyed recombination

When a `select` scope has two or more fan-out children, the staged emitter SHALL compute each
branch once as its own staged sub-chain carrying a recombination key, and SHALL recombine the
branches by joining on that key. The join SHALL be INNER for `forEach`/`unionAll` branches
and LEFT for `forEachOrNull` branches. The result SHALL equal the per-parent Cartesian
product of the branches (matching SQL-on-FHIR row-product semantics and the `struct` emitter).

#### Scenario: Two sibling forEach at the root
- **WHEN** a ViewDefinition has two sibling `forEach` children at the resource scope
- **THEN** each branch is a separate sub-pipeline keyed by the resource key
- **AND** the result is the per-resource cross product of the two branches

#### Scenario: forEach beside forEachOrNull
- **WHEN** a scope has a `forEach` branch and a `forEachOrNull` branch
- **THEN** the `forEachOrNull` branch is recombined with a LEFT join so an empty
  `forEachOrNull` still yields rows carrying the other branch's values

#### Scenario: Nested fork uses a composite key
- **WHEN** a fork occurs inside an iterating scope (e.g. siblings inside a `forEach`)
- **THEN** the recombination key includes the enclosing iteration's ordinal so branches of
  different parent instances are not cross-joined

### Requirement: Lazy keys

The staged emitter SHALL generate recombination keys only on spines that reach a fork. A
ViewDefinition containing no fork SHALL generate no resource key, no ordinals, and no joins.
Recombination keys SHALL never appear in the output.

#### Scenario: Pure chain has no key
- **WHEN** a ViewDefinition contains only chain scopes (no scope with ≥2 fan-out children)
- **THEN** the generated SQL contains no recombination key column and no recombination join

#### Scenario: Keys do not leak into output
- **WHEN** a ViewDefinition contains a fork that requires a key
- **THEN** the final projection outputs exactly the ViewDefinition's columns in tree order
- **AND** no internal key column appears in the result

### Requirement: unionAll lowering

The staged emitter SHALL lower `unionAll` as the union of its branch pipelines, which MUST
share identical output column names. In a chain scope this SHALL be a `UNION ALL` of the
branch pipelines; in a fork scope the `unionAll` SHALL participate as one keyed branch.

#### Scenario: Basic unionAll
- **WHEN** a `unionAll` lists branches with matching column names
- **THEN** the result is the concatenation of the rows produced by each branch

#### Scenario: unionAll beside another fan-out
- **WHEN** a `unionAll` is a sibling of another fan-out child
- **THEN** the `unionAll` is recombined with its siblings on the fork key

### Requirement: Output projection contract

The final `SELECT` SHALL output exactly the ViewDefinition's columns, by `name`, in tree
order, and nothing else. Internal columns used for staging or keys SHALL NOT appear in the
output, and SHALL NOT overwrite a ViewDefinition column (including a column literally named
`id`).

#### Scenario: Exact columns in tree order
- **WHEN** any supported ViewDefinition is lowered
- **THEN** the result columns are exactly the ViewDefinition's column names in tree order

### Requirement: Repeat lowering

The staged emitter SHALL lower `repeat` by descending the listed paths recursively in the
JSON binding, while evaluating every `column`, `forEach` seed, and `where` predicate on
**typed** data. The recursion SHALL be unbounded in depth (no depth cap) and SHALL exclude
the seed, matching SQL-on-FHIR `repeat` semantics and the `struct` emitter.

The descent SHALL be a `WITH RECURSIVE` CTE over a JSON node: the seed is the listed paths
off the enclosing node, and the recursive leg re-applies the listed paths to each visited
node. Listed paths SHALL be folded with the `fhir_list` navigation (single step
`fhir_list(node -> '$.p')`; multi-step `a.b` via
`list_transform(…, x -> fhir_list(x -> '$.b')).flatten()`; multiple listed paths via
`list_concat`). A ViewDefinition containing any `repeat` SHALL emit a leading
`WITH RECURSIVE`. The JSON descent SHALL be the only raw-JSON traversal.

At the scope consuming a repeat's recursive output, the emitter SHALL convert the JSON node
to a typed element with a **lenient** JSON-to-struct transform (`from_json`/`json_transform`,
NOT `CAST`), whose structure is produced by the same truncate-at-repeat-seed schema rule over
that scope's column, `forEach`, and `where` paths. The existing typed FHIRPath leaf engine
SHALL then compile every leaf against that typed element, unchanged. A **nested** `repeat`'s
seed SHALL therefore arrive as `JSON[]` and re-enter `WITH RECURSIVE`.

A lone `repeat` (the single fan-out child of its scope) SHALL be lowered as a CHAIN: no
recombination key, with the enclosing scope's already-projected scalars carried through the
recursive CTE. A `repeat` among two or more fan-out siblings SHALL be lowered as a FORK
branch that carries the fork key and recombines by `JOIN USING (key)` (the root resource key
at a root fork; the composite `(resource_key, ord_i)` at a nested fork), consistent with
"Fork scope keyed recombination".

This implementation SHALL support **simple traversal paths only**: each listed `repeat`
entry MUST be a dot-separated sequence of element names (e.g. `item`, `answer.item`,
`jurisdiction`). A listed path using functions, filters, or indexers (`where(...)`,
`ofType(...)`, `first()`, `[n]`, …) is NOT supported and SHALL be rejected with a clear
error rather than mis-evaluated.

#### Scenario: Basic repeat is a chain
- **WHEN** a ViewDefinition has a single `repeat` over `item` projecting scalar columns
- **THEN** the generated SQL descends `item` recursively via `WITH RECURSIVE` over a JSON node
- **AND** no recombination key is generated
- **AND** the result equals the `struct`-emitter oracle (all descendants, excluding the seed)

#### Scenario: Columns and forEach inside a repeat are typed
- **WHEN** a `repeat` scope contains a `column` and a `forEach` whose path is arbitrary
  FHIRPath (e.g. `value.ofType(string)`)
- **THEN** the JSON node is converted with a lenient transform to a typed element
- **AND** the column and the `forEach` seed are evaluated by the typed FHIRPath engine
- **AND** absent FHIR fields yield `NULL` rather than an error

#### Scenario: Multi-step and multiple repeat paths
- **WHEN** a `repeat` lists `["item", "answer.item"]`
- **THEN** the descent folds `item` and `answer.item` (the latter flattening through the
  `answer` array) and unions them via `list_concat`
- **AND** the result equals the `struct`-emitter oracle

#### Scenario: Nested repeat re-enters recursion via JSON
- **WHEN** a `repeat` scope contains another `repeat`
- **THEN** the inner repeat's seed field is `JSON[]` in the outer scope's transform structure
- **AND** the inner repeat descends it with its own `WITH RECURSIVE`
- **AND** the result equals the `struct`-emitter oracle at unbounded depth

#### Scenario: Sibling repeats recombine on the fork key
- **WHEN** two `repeat` siblings occur inside an iterating scope
- **THEN** each is a branch carrying the composite fork key `(resource_key, ord_i)`
- **AND** the branches recombine by `JOIN USING` that key
- **AND** branches of different parent instances are not cross-joined

#### Scenario: Repeat beside forEach sharing a field
- **WHEN** a `repeat` and a sibling `forEach` both navigate the same field
- **THEN** that field is read as `JSON[]` at the source (the repeat forces JSON)
- **AND** the `forEach` consumes it through the lenient typed transform
- **AND** the result equals the `struct`-emitter oracle

#### Scenario: Non-simple repeat path is rejected
- **WHEN** a listed `repeat` path is not a simple traversal path — it uses a function,
  filter, or indexer (`where(...)`, `ofType(...)`, `first()`, `[n]`)
- **THEN** generation fails with a clear "simple traversal paths only" error rather than
  producing a mis-folded JSON descent

### Requirement: Root fork resource key generation

When a fork occurs at the **root** (resource) scope, the staged emitter SHALL key the
recombination on the **natural resource key** by default, and SHALL NOT emit a
`row_number() OVER ()` window for this purpose. The natural resource key is the
`getResourceKey()` value, or the resource `id` when the ViewDefinition keys the root on the
resource identity. The recombination join SHALL use this key, preserving the per-resource
cross-product semantics of "Fork scope keyed recombination".

The emitter SHALL provide an opt-in alternative key mode that synthesises a per-resource
`uuid()` value for inputs where resource-`id` uniqueness or non-nullness cannot be assumed.
When the `uuid()` key mode is selected, the emitter SHALL materialise the source scope so
the volatile `uuid()` is evaluated exactly once per resource (e.g. via an `AS MATERIALIZED`
CTE), guaranteeing both fork branches observe the same key value.

In every mode the key SHALL remain internal bookkeeping: it SHALL NOT appear in the output
projection (preserving "Output projection contract").

When the natural-key mode keys a fork, the emitter SHALL ensure the resource-key path is
included in the typed read schema even if the ViewDefinition does not otherwise reference it,
so the key column is read and bound.

#### Scenario: Default root fork keys on the natural resource key
- **WHEN** a ViewDefinition has a root fork and the default key mode is in effect
- **THEN** the generated SQL recombines the branches by joining on the natural resource key
  (`getResourceKey()` / resource `id`)
- **AND** the generated SQL contains no `row_number() OVER ()` window
- **AND** the result equals the per-resource cross product of the branches

#### Scenario: Natural key works when the view projects no id column
- **WHEN** a ViewDefinition has a root fork in natural-key mode but declares no `id` column
- **THEN** the resource-key path is added to the read schema so the key is available
- **AND** the branches join on the natural resource key and the result is correct
- **AND** the resource key does not appear in the output

#### Scenario: Opt-in uuid key for non-unique resource ids
- **WHEN** the `uuid()` key mode is explicitly selected for a ViewDefinition with a root fork
- **THEN** the source scope is materialised so each resource is assigned a single `uuid()`
- **AND** both fork branches carry and join on that same `uuid()` value
- **AND** the result equals the per-resource cross product of the branches regardless of
  whether resource `id`s are unique or non-null

#### Scenario: Key never leaks into output
- **WHEN** either key mode is used for a root fork
- **THEN** the final projection outputs exactly the ViewDefinition's columns in tree order
- **AND** neither the natural resource key nor the synthesised `uuid()` appears in the result

#### Scenario: Nested fork reuses the chosen root key
- **WHEN** a fork occurs inside an iterating scope whose enclosing resource key is generated
  by the selected mode (natural or `uuid()`)
- **THEN** the composite recombination key is that resource key extended by the enclosing
  iteration's ordinal `(resource_key, ord_i)`
- **AND** branches of different parent instances are not cross-joined

