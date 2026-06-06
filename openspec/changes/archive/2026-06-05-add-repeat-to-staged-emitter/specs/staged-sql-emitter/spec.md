## MODIFIED Requirements

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

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Unsupported directives

**Reason**: `repeat` is now supported by the staged backend (see "Repeat lowering"); the
emitter no longer rejects it. This requirement had no other content.

**Migration**: `repeat` ViewDefinitions previously routed to the `struct` backend now run on
the `staged` backend with multiset-identical results; no caller change is required.
