## ADDED Requirements

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

#### Scenario: Resource filtering
- **WHEN** a ViewDefinition declares `resource: "Patient"` with resource filtering enabled
- **THEN** the source CTE restricts rows to `resourceType = 'Patient'`

#### Scenario: Where predicate applied at the source
- **WHEN** a ViewDefinition declares a `where` predicate that must yield a boolean
- **THEN** the predicate is evaluated on the source CTE and rows failing it are excluded
- **AND** a `where` path that does not yield a boolean is rejected with an error

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

### Requirement: Unsupported directives

The staged emitter SHALL reject ViewDefinitions that use `repeat` with a clear error
indicating the staged backend does not support it, so such views are routed to the `struct`
backend rather than producing incorrect SQL.

#### Scenario: repeat is rejected
- **WHEN** a ViewDefinition contains a `repeat` directive and the `staged` backend is selected
- **THEN** generation fails with a clear "not supported by staged backend" error
