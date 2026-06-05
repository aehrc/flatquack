# struct-sql-emitter

## Purpose

Defines `repeat` lowering and configurable repeat depth for the `struct` SQL backend of the
query builder, lowering a ViewDefinition's `repeat` paths into a bounded `list_reduce`
accumulator over the typed JSON binding while producing result rows that match the
SQL-on-FHIR `repeat.json` oracle and the `staged` backend.

## Requirements

### Requirement: Repeat lowering (struct backend)

The `struct` emitter SHALL lower `repeat` by descending the listed paths recursively in the JSON
binding, while evaluating every `column`, `forEach` seed, and `where` predicate on **typed** data.
The recursion SHALL exclude the resource focus and include the seed-level elements and their
descendants, matching SQL-on-FHIR `repeat` semantics and the official `repeat.json` oracle.

The recursion SHALL be expressed as a **bounded `list_reduce` accumulator** (NOT `WITH
RECURSIVE`), composed inside the emitter's Phase-1 value expression so that a `repeat` produces a
list-valued field that the existing flattener consumes with `CROSS JOIN UNNEST` — identically to a
`forEach`. The accumulator SHALL carry the accumulated nodes and the current frontier; once the
frontier is empty, further steps SHALL be no-ops. The accumulator SHALL NOT use a struct field
named `all` (a reserved word).

The descent SHALL navigate JSON via the `fhir_list` fold: single step `fhir_list(node -> '$.p')`;
multi-step `a.b` via `list_transform(…, x -> fhir_list(x -> '$.b')).flatten()`; multiple listed
paths via `list_concat`. Each accumulated JSON node SHALL be converted to a typed element with a
**lenient** `from_json(node, '<structure>')` transform (NOT `CAST`), whose structure is produced
by the same truncate-at-repeat-seed schema rule used for the source read. The existing typed
FHIRPath leaf engine SHALL then compile every leaf against that typed element, unchanged.

The repeat seed field SHALL be read as `JSON[]` in the `read_json` `columns=` schema (a recursive
FHIR type is not a finite typed STRUCT); this truncation SHALL propagate up through enclosing
structs while sibling fields remain typed. A **nested** `repeat`'s seed SHALL therefore arrive as
`JSON[]` in the enclosing scope's transform structure and re-enter its own bounded accumulator.

This implementation SHALL support **simple traversal paths only**: each listed `repeat` entry MUST
be a dot-separated sequence of element names (e.g. `item`, `answer.item`). A listed path using
functions, filters, or indexers (`where(...)`, `ofType(...)`, `first()`, `[n]`, …) is NOT
supported and SHALL be rejected with a clear error rather than mis-evaluated.

#### Scenario: Basic repeat returns seed and all descendants

- **WHEN** a ViewDefinition has a single `repeat` over `item` projecting scalar columns
- **THEN** the generated SQL descends `item` via a `list_reduce` accumulator over a JSON node and
  the result is `CROSS JOIN UNNEST`ed as a list field
- **AND** the result equals the `repeat.json` oracle (the seed-level items and all descendants,
  excluding the resource focus)

#### Scenario: Columns and forEach inside a repeat are typed

- **WHEN** a `repeat` scope contains a `column` and a `forEach` whose path is arbitrary FHIRPath
  (e.g. `value.ofType(string)`)
- **THEN** each accumulated JSON node is converted with a lenient `from_json` transform to a typed
  element
- **AND** the column and the `forEach` seed are evaluated by the typed FHIRPath engine
- **AND** absent FHIR fields yield `NULL` rather than an error
- **AND** a choice-type leaf binds the matching `valueX` field (e.g. `value.ofType(string)` →
  `el.valueString`)

#### Scenario: Multi-step and multiple repeat paths

- **WHEN** a `repeat` lists `["item", "answer.item"]`
- **THEN** the descent folds `item` and `answer.item` (the latter flattening through the `answer`
  array) and unions them via `list_concat`
- **AND** the result equals the `repeat.json` oracle

#### Scenario: Nested repeat re-enters recursion via JSON

- **WHEN** a `repeat` scope contains another `repeat`
- **THEN** the inner repeat's seed field is `JSON[]` in the outer scope's transform structure
- **AND** the inner repeat descends it with its own bounded accumulator nested in the value
  expression
- **AND** the result equals the `repeat.json` oracle within the configured depth

#### Scenario: Sibling repeats produce a Cartesian product without keys

- **WHEN** two `repeat` siblings occur in the same scope
- **THEN** each becomes its own list-valued field and is `CROSS JOIN UNNEST`ed
- **AND** the result is the per-parent cross product of the two branches
- **AND** no recombination key column or recombination join is generated

#### Scenario: Repeat beside forEach sharing a field

- **WHEN** a `repeat` and a sibling `forEach` both navigate the same field
- **THEN** that field is read as `JSON[]` at the source (the repeat forces JSON)
- **AND** the `forEach` consumes it through the lenient typed transform
- **AND** the result equals the `repeat.json` oracle

#### Scenario: Result matches the staged backend

- **WHEN** any official `repeat.json` ViewDefinition is lowered on both the `struct` and `staged`
  backends
- **THEN** the two backends produce multiset-identical result rows (within the configured depth)

#### Scenario: Non-simple repeat path is rejected

- **WHEN** a listed `repeat` path uses a function, filter, or indexer (`where(...)`,
  `ofType(...)`, `first()`, `[n]`)
- **THEN** generation fails with a clear "simple traversal paths only" error rather than producing
  a mis-folded JSON descent

### Requirement: Configurable repeat depth

The `struct` emitter's `repeat` recursion SHALL be bounded by a configurable maximum depth, with a
default of **10**. The depth SHALL be exposed as a CLI option `--repeat-depth` and threaded through
the query-building API to the emitter, where it is baked into the accumulator's driver length
(`list_resize(…, depth + 1)`). Descendants deeper than the configured depth SHALL be omitted from
the result; the emitted SQL size SHALL NOT grow with the depth value.

The bounded depth is a deliberate divergence from the `staged` backend's unbounded recursion and
SHALL be documented as a limitation; raising `--repeat-depth` is the supported way to handle data
nested more deeply than the default.

#### Scenario: Default depth covers typical nesting

- **WHEN** a `repeat` view is built without specifying a depth
- **THEN** the recursion is bounded at depth 10
- **AND** data nested at or below 10 levels returns every descendant

#### Scenario: Depth is configurable via the CLI

- **WHEN** a caller passes `--repeat-depth N`
- **THEN** the accumulator driver length reflects `N` (the `list_resize` target is `N + 1`)
- **AND** the generated SQL string is the same length as for any other depth value

#### Scenario: Data deeper than the configured depth is truncated

- **WHEN** a resource is nested more deeply than the configured `repeat` depth
- **THEN** descendants beyond that depth are omitted from the result without error

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
