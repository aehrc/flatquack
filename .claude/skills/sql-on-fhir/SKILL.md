---
name: sql-on-fhir
description: Authoritative knowledge base for SQL on FHIR v2 specification. Use this skill whenever the user asks questions about SQL on FHIR concepts, ViewDefinitions, FHIRPath expressions in views, view operations ($run, $export), flattening FHIR data into tables, or how any part of the SQL on FHIR spec works. Trigger on questions like "what is a ViewDefinition", "how does forEach work", "what FHIRPath functions are supported", "how do I filter resources in a view", "what's the difference between forEach and forEachOrNull", "how does repeat work", "what is $viewdefinition-run", "how does $export work", "what are constants in SQL on FHIR", "what is unionAll", "what profiles exist for ViewDefinitions". Also trigger on keywords: "ViewDefinition", "SQL on FHIR", "flatten FHIR", "tabular FHIR", "FHIR to SQL", "FHIR analytics", "FHIRPath columns", "unnest FHIR", "$viewdefinition-run", "$export", "view runner", "repeat", "forEachOrNull", "forEach", "QuestionnaireResponse items", "ShareableViewDefinition", "TabularViewDefinition".
---

# SQL on FHIR v2 -- Expert Knowledge Base

You are an authoritative expert on the SQL on FHIR v2 specification. When answering questions, draw on the reference material below and in the linked reference files. Provide accurate, precise answers grounded in the spec. When a concept has nuances or constraints, mention them proactively.

## How to use this skill

1. For questions about **ViewDefinition structure and elements**, consult the sections below and [references/view-definition-structure.md](references/view-definition-structure.md) for the complete element reference.
2. For questions about **FHIRPath expressions** supported in views, consult the FHIRPath section below and [references/fhirpath-subset.md](references/fhirpath-subset.md) for the full function and operator reference.
3. For questions about **operations** ($run, $export, CapabilityStatement), consult the operations section below and [references/operations.md](references/operations.md) for full parameter details, async flow, and HTTP examples.
4. For questions that benefit from **concrete examples**, consult [references/examples.md](references/examples.md) which covers Patient demographics, Conditions, Observations, Encounters, QuestionnaireResponses, extensions, unions, and more.

Always cite the relevant spec concepts. When showing examples, prefer examples from the reference files rather than inventing new ones, unless the user's question requires a tailored example.

---

## Overview

SQL on FHIR v2 defines a portable, implementation-independent way to project hierarchical FHIR resources into flat, tabular views using **ViewDefinitions**. The key idea: a ViewDefinition describes *what* columns to extract from *which* resource type, using FHIRPath expressions. It deliberately excludes cross-resource joins, sorting, aggregation, and output formatting -- those belong in the analytics layer (SQL, BI tools) that consumes the flattened tables.

## Core Concepts

### ViewDefinition

A ViewDefinition is a FHIR resource (resourceType: "ViewDefinition") that projects exactly one FHIR resource type into rows and columns. Its key elements:

- **`resource`** (required): The FHIR resource type to project (e.g., Patient, Observation)
- **`select`** (required): One or more selection blocks defining columns and row iteration
- **`where`** (optional): Filtering criteria applied before projection
- **`constant`** (optional): Named values reusable in FHIRPath expressions via `%name`
- **`status`** (required): Lifecycle status (draft, active, retired, unknown)

For the complete element reference with cardinalities and types, see [references/view-definition-structure.md](references/view-definition-structure.md).

### Columns

Each column in a `select` block defines one output field:

- **`name`**: Database-friendly identifier (pattern: `^[A-Za-z][A-Za-z0-9_]*$`)
- **`path`**: FHIRPath expression that extracts the value
- **`type`** (optional): FHIR primitive type URI -- required for ShareableViewDefinition
- **`collection`** (optional): Set to true if the column may contain arrays (incompatible with TabularViewDefinition)
- **`description`** (optional): Human-readable explanation

### Row Generation

By default, a ViewDefinition produces **one row per resource**. Three mechanisms change this:

| Mechanism        | Behavior                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| **`forEach`**    | One row per element in the evaluated collection. Empty collection = no rows. |
| **`forEachOrNull`** | Same as forEach, but produces one row with nulls when the collection is empty. |
| **`repeat`**     | Recursively traverses nested structures to arbitrary depth, unioning all results. |

**Constraint**: Only one of `forEach`, `forEachOrNull`, or `repeat` may appear per select block.

**Nesting**: `select` blocks can be nested. When a `forEach` is nested inside another `forEach`, the result is a cross-product of the outer and inner collections.

### Filtering with `where`

The `where` element contains FHIRPath expressions that must evaluate to `true` for a resource to be included. Multiple `where` clauses are ANDed together.

### Constants

Named values defined at the ViewDefinition level and referenced in FHIRPath via `%name`. Supported value types include `valueString`, `valueInteger`, `valueBoolean`, `valueDecimal`, `valueDate`, `valueDateTime`, `valueCode`, and many more (see [references/view-definition-structure.md](references/view-definition-structure.md) for the full list).

### unionAll

Combines multiple selection branches that must produce **identical column schemas** (same names, same order). Useful for collecting data from different paths within the same resource into a single table.

### repeat (Recursive Traversal)

The `repeat` element takes an array of FHIRPath expressions. The view runner:
1. Starts at the current context
2. Evaluates each path expression
3. For each result, recursively applies the same paths
4. Continues until no more matches exist
5. Unions all results from all depth levels

The canonical use case is QuestionnaireResponse items, where `item` and `answer.item` nest to unknown depth.

## FHIRPath Subset

ViewDefinitions use a **minimal, portable subset** of FHIRPath -- not the full spec. Key supported features:

- **Navigation**: dot notation (`name.family`), indexing (`name[0]`), `$this`
- **Collection functions**: `first()`, `exists()`, `empty()`, `where(expr)`, `ofType(type)`, `join(sep)`
- **Extension access**: `extension(url)` with chaining for nested extensions
- **Reference functions**: `getResourceKey()`, `getReferenceKey(type?)`
- **Operators**: `=`, `!=`, `<`, `<=`, `>`, `>=`, `and`, `or`, `not`
- **Literals**: strings (`'value'`), numbers, booleans (`true`/`false`), dates (`@2024-01-01`)
- **Constants**: `%name` references

**Notable exclusions**: `iif()`, `select()`, `repeat()` (at path level), `aggregate()`, arithmetic operators, string concatenation (`&`), regex matching.

For the complete function and operator reference, see [references/fhirpath-subset.md](references/fhirpath-subset.md).

## Profiles

Two profiles constrain ViewDefinitions for specific use cases:

- **ShareableViewDefinition**: For portable, publishable definitions. Requires `url`, `name`, `fhirVersion`, and explicit `type` on all columns.
- **TabularViewDefinition**: For scalar/CSV-compatible output. Forbids `collection: true` columns and allows only primitive types.

## Operations

SQL on FHIR defines two operations for executing ViewDefinitions:

- **`$viewdefinition-run`**: Synchronous execution returning results immediately. Supports GET (instance-level) and POST (type-level with inline or referenced ViewDefinition). Output formats: json, ndjson, csv, parquet.
- **`$export`**: Asynchronous bulk export using the FHIR async request pattern (POST with `Prefer: respond-async`, poll status URL, download results). Supports exporting multiple ViewDefinitions in one request.

Both operations support filtering by patient, group, and `_since` timestamp.

For complete parameter tables, HTTP examples, status codes, and the async flow, see [references/operations.md](references/operations.md).

## Design Philosophy

ViewDefinitions intentionally **exclude**:
- Cross-resource joins (use SQL after flattening)
- Sorting, aggregation, limits (apply in the analytics layer)
- Output format specification (the runner determines format)
- Complex FHIRPath (keeps views portable across implementations)

This separation of concerns means ViewDefinitions handle the "FHIR to table" transformation, while downstream tools handle the "table to insight" transformation.

## Examples

For comprehensive worked examples covering Patient demographics, addresses (forEach and forEachOrNull), Conditions, blood pressure Observations with filtering, Encounters with nested diagnoses, telecom unions, US Core extensions, QuestionnaireResponse recursive items, collection columns, ShareableViewDefinitions, MedicationRequests, and DiagnosticReports, see [references/examples.md](references/examples.md).
