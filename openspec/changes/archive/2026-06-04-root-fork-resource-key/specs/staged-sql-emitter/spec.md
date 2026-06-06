## ADDED Requirements

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
