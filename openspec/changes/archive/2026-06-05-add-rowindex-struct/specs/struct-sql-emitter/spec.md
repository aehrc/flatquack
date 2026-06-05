## ADDED Requirements

### Requirement: `%rowIndex` environment variable (struct backend)

The `struct` emitter SHALL support the SQL-on-FHIR `%rowIndex` environment variable, evaluating it
to the **0-based** position of the current element within the **nearest enclosing iteration**
(`forEach`, `forEachOrNull`, or `repeat`). Where there is no enclosing iteration — at the resource
root, or inside a `unionAll` branch that does not itself iterate — `%rowIndex` SHALL evaluate to
`0`.

`%rowIndex` SHALL be recognized by the FHIRPath front end as a **contextual** environment variable,
distinct from user-supplied `--var` constants: a view referencing `%rowIndex` SHALL compile without
requiring `--var rowIndex=…` and SHALL NOT raise "Variable %rowIndex is not defined". Other
`%`-constants SHALL continue to resolve through the existing `--var` mechanism unchanged.

The emitter SHALL realize `%rowIndex` by binding it to the index of the `list_transform` lambda
that performs the enclosing iteration. Because DuckDB's `list_transform` index parameter is
1-based, the bound value SHALL be `(<index> - 1)`. Each iteration level SHALL introduce its own
index binding so that nested iterations report independent positions.

The emitter SHALL distinguish a **projection** use of its column-wrapping directive (the resource
root, a `select`, or a `unionAll` branch — none of which iterate) from a real **iteration**
(`forEach`/`forEachOrNull`/`repeat`). A projection SHALL NOT open a new `%rowIndex` scope; it SHALL
pass the enclosing iteration's index through unchanged (so a non-iterating `unionAll` branch
reports the index of the iteration that contains it, or `0` at the root).

For `forEachOrNull` over an absent or empty collection, the synthesized null row SHALL report
`%rowIndex = 0`. The emitter SHALL achieve this by padding the iteration **source** (so the null
row passes through the indexed lambda) rather than padding the transform result.

For `repeat`, `%rowIndex` SHALL be the position of the element within the emitter's existing
flattened (breadth-first) accumulator order. Reproducing the SQL-on-FHIR reference depth-first
pre-order numbering for `repeat` is explicitly **out of scope** for this change (see Non-Goals in
the design); the corresponding `row_index.json` `repeat` sub-test is a known follow-up.

#### Scenario: `%rowIndex` at the resource root is 0

- **WHEN** a column path is `%rowIndex` with no enclosing `forEach`/`forEachOrNull`/`repeat`
- **THEN** the column SHALL evaluate to `0` for every resource row

#### Scenario: `%rowIndex` under `forEach` numbers each element

- **WHEN** a `forEach` over a collection projects a column with path `%rowIndex`
- **THEN** the column SHALL be `0` for the first element, `1` for the second, and so on, restarting
  per enclosing resource

#### Scenario: `%rowIndex` under `forEachOrNull` reports 0 for the null row

- **WHEN** a `forEachOrNull` iterates a collection that is absent or empty for a given resource
- **THEN** the synthesized null row SHALL report `%rowIndex = 0`
- **AND** non-empty collections SHALL number their elements `0, 1, …`

#### Scenario: Nested `forEach` levels report independent indices

- **WHEN** an inner `forEach` is nested inside an outer `forEach`, each projecting `%rowIndex`
- **THEN** the inner column SHALL reflect the position within the inner collection
- **AND** the outer column SHALL reflect the position within the outer collection, independently

#### Scenario: Each `unionAll` branch maintains its own index sequence

- **WHEN** a `unionAll` has multiple branches that each `forEach` over different collections, each
  projecting `%rowIndex`
- **THEN** each branch SHALL number its own elements from `0`, independently of the other branches

#### Scenario: A non-iterating `unionAll` branch inherits the enclosing index

- **WHEN** a `unionAll` branch has no `forEach` of its own and projects `%rowIndex`
- **THEN** at the resource root the branch SHALL report `0`
- **AND** when the `unionAll` is nested inside a `forEach`, the branch SHALL report the enclosing
  `forEach`'s index for that row
