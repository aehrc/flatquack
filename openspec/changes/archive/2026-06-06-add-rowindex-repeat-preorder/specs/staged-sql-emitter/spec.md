## MODIFIED Requirements

### Requirement: `%rowIndex` environment variable (staged backend)

The `staged` emitter SHALL support the SQL-on-FHIR `%rowIndex` environment variable, evaluating it
to the **0-based** position of the current element within the **nearest enclosing iteration**
(`forEach`, `forEachOrNull`, or `repeat`). Where there is no enclosing iteration — at the resource
root, or inside a `unionAll` branch that does not itself iterate — `%rowIndex` SHALL evaluate to `0`.

`%rowIndex` is recognized by the FHIRPath front end as a **contextual** environment variable
(shared with the `struct` backend): a view referencing `%rowIndex` SHALL compile without requiring
`--var rowIndex=…` and SHALL NOT raise "Variable %rowIndex is not defined". Other `%`-constants
SHALL continue to resolve through the existing `--var` mechanism unchanged.

For `forEach`/`forEachOrNull`, the emitter SHALL realize `%rowIndex` using the **1-based ordinal** of
the `UNNEST … WITH ORDINALITY` that performs the enclosing iteration, binding `%rowIndex` to
`(<ordinal> - 1)`. The emitter SHALL emit that ordinal whenever a `forEach`/`forEachOrNull`'s scope
uses `%rowIndex`, in addition to the existing case where the subtree forks. The ordinal SHALL be
added to the recombination key chain **only** for forks; for the index-only case it SHALL be aliased
in the iteration's `FROM` clause and consumed by the column expression in that stage, without
altering recombination keys. Each iteration level SHALL carry its own ordinal so nested iterations
report independent positions.

For `forEachOrNull` over an absent or empty collection, the synthesized null row (whose
`LEFT JOIN … WITH ORDINALITY` ordinal is `NULL`) SHALL report `%rowIndex = 0`; the emitter SHALL
achieve this with `(coalesce(<ordinal>, 1) - 1)`.

For a `repeat`, `%rowIndex` SHALL be the **0-based position of the visited node in the depth-first
pre-order traversal** of the repeat's descent (e.g. `linkId 1, 1.1, 1.2, 2 → 0, 1, 2, 3`),
restarting per the repeat's enclosing-scope instance. The emitter SHALL realize this by carrying a
**materialized integer descent path** through the `WITH RECURSIVE` descent — the seed leg binding
`[ordinal]::BIGINT[]` from an `UNNEST … WITH ORDINALITY` over the seed array, and the recursive leg
binding `list_append(<parent path>, ordinal)` from an `UNNEST … WITH ORDINALITY` over the descent
fold — and assigning, at the repeat's typed bridge stage (one row per visited node, **before** any
fork recombination), `%rowIndex = (row_number() OVER (PARTITION BY <enclosing-scope key> ORDER BY
<path>) - 1)`. The path SHALL be ordered as an **integer list** (element-wise), never a string, so
pre-order is preserved at and beyond ten siblings. The resulting index SHALL be materialized as an
ordinary scalar column and SHALL be carried through any subsequent recombination join unchanged.

The enclosing-scope key for a `repeat`'s window SHALL identify the repeat's parent iteration
instance: the resource (`rid`) for a root repeat; the enclosing `forEach`/`forEachOrNull` instance
for a repeat nested inside an iteration; and the enclosing `repeat`'s own `%rowIndex` value for a
repeat nested inside a repeat (so nested repeats chain their indices — `(rid, outer_rn)` — and never
`PARTITION BY` a list). The emitter SHALL **force** this key to exist whenever a `repeat` below uses
`%rowIndex`, even for a view that contains no fork: it SHALL emit the resource key (`rid`) and the
enclosing iterating steps' ordinals as carried key columns down the spine to that repeat, by the same
look-ahead used for forks. When a `repeat`'s body does not use `%rowIndex`, the emitter SHALL emit no
descent path, no ordinal, and no window, and the generated `repeat` SQL and keys SHALL be unchanged.

Within a `unionAll`, each `forEach`/`forEachOrNull` branch that uses `%rowIndex` SHALL unnest with
its own `WITH ORDINALITY` ordinal and number its elements independently from `0`; a `repeat` branch
that uses `%rowIndex` SHALL number its visited nodes by its own pre-order descent as above. A
`unionAll` branch with no iteration of its own SHALL inherit the enclosing iteration's index (`0` at
the resource root, or the enclosing `forEach`'s index when the `unionAll` is nested inside a
`forEach`).

The emitter SHALL detect `%rowIndex` usage that requires an enclosing ordinal (or, for a `repeat`, a
descent path and window) by parsing the candidate column paths and inspecting for the contextual
`rowIndex` segment. Candidate paths are the columns that compile against the scope's element: the
scope's direct and transparently-merged columns, any columns-only `unionAll` branch (including nested
unions), and a `repeat` fan-out's body compiled against its typed bridge element. The key-forcing
look-ahead SHALL additionally report whether any `repeat` in a subtree uses `%rowIndex`.

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

#### Scenario: `%rowIndex` over a `repeat` numbers in depth-first pre-order

- **WHEN** a `repeat` over `item` projects a `%rowIndex` column, with parent `1` having children
  `1.1`, `1.2` and a sibling `2`
- **THEN** the visited nodes `1, 1.1, 1.2, 2` SHALL report `%rowIndex = 0, 1, 2, 3` respectively
- **AND** the numbering SHALL be produced by ordering an integer descent path, not by the
  breadth-first accumulation order of the descent CTE

#### Scenario: `%rowIndex` over a fork-free `repeat` restarts per resource

- **WHEN** a lone `repeat` (the single fan-out child of its scope, no fork anywhere) projects
  `%rowIndex` over **multiple** resources
- **THEN** the pre-order index SHALL restart at `0` for each resource
- **AND** the emitter SHALL force a per-resource partition key (`rid`) even though the view has no
  fork

#### Scenario: `%rowIndex` over a `repeat` nested in a `forEach` restarts per enclosing element

- **WHEN** a `repeat` projecting `%rowIndex` is nested inside a `forEach`
- **THEN** the repeat's pre-order index SHALL restart at `0` for each enclosing `forEach` element
- **AND** the enclosing `forEach` SHALL mint its ordinal as a carried key down to the repeat even
  when the view has no fork

#### Scenario: `%rowIndex` over a `repeat` nested in a `repeat` chains its index

- **WHEN** an inner `repeat` projecting `%rowIndex` is nested inside an outer `repeat`
- **THEN** the inner index SHALL restart at `0` for each visited outer node
- **AND** the inner window SHALL partition by the outer repeat's own `%rowIndex` (so no `PARTITION
  BY` over a list is required)

#### Scenario: `%rowIndex` over a `repeat` at a fork survives recombination

- **WHEN** a `repeat` projecting `%rowIndex` is one of two or more fan-out siblings (a fork)
- **THEN** the repeat's pre-order index SHALL be assigned at the repeat's own scope and carried as a
  scalar through the fork join
- **AND** the index SHALL NOT be inflated by the cross-product with the sibling branch

#### Scenario: Iteration without `%rowIndex` emits no extra ordinal

- **WHEN** a `forEach` whose subtree does not fork, or a `repeat` whose body does not use
  `%rowIndex`, projects no `%rowIndex` column
- **THEN** the emitter SHALL NOT add a `WITH ORDINALITY` ordinal, descent path, or window for that
  iteration
- **AND** the generated SQL and recombination keys SHALL be unchanged from before this change
