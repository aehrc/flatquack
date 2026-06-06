## ADDED Requirements

### Requirement: `%rowIndex` environment variable (staged backend)

The `staged` emitter SHALL support the SQL-on-FHIR `%rowIndex` environment variable, evaluating it
to the **0-based** position of the current element within the **nearest enclosing iteration**
(`forEach` or `forEachOrNull`). Where there is no enclosing iteration — at the resource root, or
inside a `unionAll` branch that does not itself iterate — `%rowIndex` SHALL evaluate to `0`.

`%rowIndex` is recognized by the FHIRPath front end as a **contextual** environment variable
(shared with the `struct` backend): a view referencing `%rowIndex` SHALL compile without requiring
`--var rowIndex=…` and SHALL NOT raise "Variable %rowIndex is not defined". Other `%`-constants
SHALL continue to resolve through the existing `--var` mechanism unchanged.

The emitter SHALL realize `%rowIndex` using the **1-based ordinal** of the `UNNEST … WITH
ORDINALITY` that performs the enclosing iteration, binding `%rowIndex` to `(<ordinal> - 1)`. The
emitter SHALL emit that ordinal whenever a `forEach`/`forEachOrNull`'s scope uses `%rowIndex`, in
addition to the existing case where the subtree forks. The ordinal SHALL be added to the
recombination key chain **only** for forks; for the index-only case it SHALL be aliased in the
iteration's `FROM` clause and consumed by the column expression in that stage, without altering
recombination keys. Each iteration level SHALL carry its own ordinal so nested iterations report
independent positions.

For `forEachOrNull` over an absent or empty collection, the synthesized null row (whose
`LEFT JOIN … WITH ORDINALITY` ordinal is `NULL`) SHALL report `%rowIndex = 0`; the emitter SHALL
achieve this with `(coalesce(<ordinal>, 1) - 1)`.

Within a `unionAll`, each `forEach`/`forEachOrNull` branch that uses `%rowIndex` SHALL unnest with
its own `WITH ORDINALITY` ordinal and number its elements independently from `0`. A `unionAll`
branch with no iteration of its own SHALL inherit the enclosing iteration's index (`0` at the
resource root, or the enclosing `forEach`'s index when the `unionAll` is nested inside a `forEach`).

The emitter SHALL detect `%rowIndex` usage that requires an enclosing ordinal by parsing the
candidate column paths and inspecting for the contextual `rowIndex` segment. Candidate paths are the
columns that compile against the scope's element: the scope's direct and transparently-merged
columns, and any columns-only `unionAll` branch (including nested unions).

`%rowIndex` over `repeat` is **out of scope** for this change (see Non-Goals in the design): the
staged `repeat` descent is breadth-first and does not reproduce the SQL-on-FHIR depth-first
pre-order numbering, and the corresponding `row_index.json` `repeat` sub-test is a known follow-up,
mirroring the `struct` backend's current state.

#### Scenario: `%rowIndex` at the resource root is 0

- **WHEN** a column path is `%rowIndex` with no enclosing `forEach`/`forEachOrNull`
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

#### Scenario: Iteration without `%rowIndex` emits no extra ordinal

- **WHEN** a `forEach` whose subtree does not fork projects no `%rowIndex` column
- **THEN** the emitter SHALL NOT add a `WITH ORDINALITY` ordinal for that iteration
- **AND** the generated SQL and recombination keys SHALL be unchanged from before this change
