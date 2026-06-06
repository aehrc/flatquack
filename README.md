/o# FlatQuack

**FlatQuack is an open source tool to convert healthcare data in FHIR format into flat CSV, Parquet, JSON, or database tables that are ready for analysis using off-the-shelf tools. Not sure what this means? Check out the overview below :).**

## Overview

As the availability of healthcare data in [FHIR format](https://hl7.org/fhir) increases, there is a growing interest in using this data for analytic purposes. Most analytic and machine learning use cases require the preparation of FHIR data using transformations and tabular projections from its original, deeply nested form and authoring and maintaining these transformations is not trivial. The [SQL-on-FHIR](https://sql-on-fhir.org) specification defines a compact language to describe these transformations called a [FHIR ViewDefinition](https://sql-on-fhir.org/ig/latest/StructureDefinition-ViewDefinition.html).

FlatQuack is an open source tool that compiles these ViewDefinitions into SQL that can be executed with [DuckDB](https://duckdb.org). DuckDB is a lightweight, scalable, open source database engine that runs at blazing speed thanks to its columnar engine, which supports parallel execution and can process larger-than-memory workloads. DuckDB natively supports reading and writing data in common formats like JSON, Parquet and CSV and can even integrate directly with remote endpoints such as AWS S3 buckets and databases such as Postgres, MySql and SQLite. FlatQuack takes advantage of this capability with the ability to specify templates that shape the SQL produced by FlatQuack to different use cases, making it easy to adapt to the specific naming conventions, input file formats, and output file formats in your workflow. Since FlatQuack just outputs SQL, it can be run directly on a FHIR dataset for a specific project or integrated into an existing data pipeline that uses orchestration and transformation tools like [Apache Airflow](https://airflow.apache.org/) and [dbt](https://getdbt.com).  

## Alpha Version

FlatQuack is alpha software - it is not complete and you may run into bugs when using it. Please see the [project roadmap](#roadmap), [contribution guidelines](#contributing), and [support](#support) sections below for more information.

## Setup

1. Install [bun](https://bun.sh) - Bun is an open source Javascript runtime similar to node.js
2. You may also want to install the latest version of [DuckDB](https://duckdb.org) if you plan to execute the generated SQL queries outside of the FlatQuack command line interface (recommended for large datasets)

Additional steps if you would like to run scripts, unit tests or edit the project's source code:

3. Clone this repository and switch to that directory
4. Run the `bun install` command to install FlatQuack dependencies 

## Running FlatQuack

#### `bunx flatquack` 

(or `bun run ./src/cli.js` if you installed FlatQuack locally using steps 3 and 4 above)

#### Command line arguments

| name | short | default value | description |
| --- |  --- |  --- |  --- |
| `--mode` | `-m` | `preview` | Action FlatQuack should take with generated SQL. See the [modes section](#modes---mode-parameter) below for details. |
| `--view-path` | `-v` | current directory | The absolute or relative path to your ViewDefinition JSON files. Note that the -view-pattern parameter describes which files within this path will be used. |
| `--view-pattern` | `-p` |  `**/*.vd.json` | [Glob pattern](https://bun.sh/docs/api/glob) to define which files are ViewDefinitions. |
| `--template` | `-t` | `@csv` | Path to [template](#templates---template-parameter) to use when generating SQL. May be the name of a [sample template](#sample-templates) or the path to a [custom template](#custom-templates) |
| `--schema-file` | `-s` | FHIR R4 Schema | Path to a FHIR schema generated using the script included at `./scripts/build-fhir-schema.js`. This can be used to execute ViewDefinitions against FHIR data from versions other than R4.  See the [Generating a FHIR Schema](#generating-a-fhir-schema) seciton below for details.|
| `--macros` | | | Experimental - Path to file(s) or directory(ies) containing additional SQL macros. Prefix with `@` to reference files in the templates directory. This argument may be repeated. See [details below](#macros---macros-parameter).| 
| `--backend` | | `struct` | SQL emitter to use: `struct` (the default) or `staged` (the SPEC_hybrid emitter). See [Backends](#backends---backend-parameter) below. |
| `--root-key` | | `natural` | Staged-backend only. Recombination key used to re-join the root fan-out: `natural` (the resource key) or `uuid` (a synthesized per-resource id). |
| `--repeat-depth` | | `10` | Struct-backend only. Maximum recursion depth when expanding a `repeat` in a ViewDefinition. |
| `--param` | | | `name=value` pair of user defined variables to be used when generating SQL with a [custom template](#custom-templates). This argument may be repeated. | 
| `--var` | | | `name=value` pair of FHIRPath variables for use in ViewDefinition expressions (referenced as `%name`). This argument may be repeated. | 
| `--verbose` | | false | Print debugging information to the console when running FlatQuack. |

#### Modes (--mode parameter)
| name | description |
| --- |  --- |
| `preview` (default) | Generate SQL and display it in the console. |
| `build` | Generate SQL and save it in the same directory as the source ViewDefinition. |
| `run` | Execute the SQL and print the time it took to run in the console. | 
| `explore` | Execute the SQL and print the query output in the console as JSON. Large queries should use the `build` action and run the resulting SQL files [directly with DuckDB](https://duckdb.org/docs/api/cli/overview#non-interactive-usage). |

## Backends (--backend parameter)

FlatQuack has two SQL emitters that compile a ViewDefinition into different SQL shapes. Both produce
the same flattened output; they differ in how the SQL is structured and in their performance
characteristics on different views.

| name | description |
| --- | --- |
| `struct` (default) | Compiles the whole projection into a single typed expression over a struct-typed read of the source, flattened with `UNNEST`/joins. A good default for most views. |
| `staged` | The *SPEC_hybrid* emitter. Walks the ViewDefinition into a chain of staged CTEs, re-joining fan-outs on a recombination key. Better suited to views with deep fan-out forks and to `repeat`. See [docs/SPEC_hybrid.md](./docs/SPEC_hybrid.md) for the design. |

Switching backends is as simple as adding `--backend staged`; the built-in templates resolve to a
backend-appropriate variant automatically (see below). The `--root-key` parameter tunes the staged
backend's root recombination; `--repeat-depth` tunes the struct backend's `repeat` expansion.

## Templates (--template parameter)

### Sample Templates
| name | input | output |
| --- | --- | --- |
| [`@csv`](./templates/csv.sql) (default) | NDJSON FHIR Bulk Data files with a `.ndjson` extension and the resource type in the name | Flat CSV files with a header row |
| [`@parquet`](./templates/parquet.sql) | NDJSON FHIR Bulk Data files with a `.ndjson` extension and the resource type in the name | Parquet files ready for additional processing |
| [`@ndjson`](./templates/ndjson.sql) | NDJSON FHIR Bulk Data files with a `.ndjson` extension | NDJSON file with one line per output row and just the abstracted data|
| [`@dbt_model`](./templates/dbt_model.sql) | DBT Source named `fhir_db` with tables named as FHIR resource types | SQL Select statement that returns a flat table |
| [`@dbt_prehook`](./templates/dbt_prehook.sql) | NA | DuckDB SQL macros to load before executing a query generated with FlatQuack |
| [`@explore`](./templates/explore.sql) (default for the `explore` mode) | NDJSON FHIR Bulk Data files with a `.ndjson` extension and the resource type in the name | Flattened table with up to 10 results |

#### Backend-aware resolution

Built-in `@name` templates resolve to a variant that matches the active `--backend`. When
`--backend staged` is used, FlatQuack first looks for `templates/staged/<name>.sql` and falls back
to `templates/<name>.sql` if no staged variant exists. The `struct` backend always uses
`templates/<name>.sql`. This means `@csv`, `@parquet`, `@ndjson`, `@explore`, and `@dbt_model` all
work under both backends with no other change.

A practical consequence: if you customize a root template such as `templates/csv.sql`, your change
applies to the `struct` backend. To customize the `staged` output, edit (or create)
`templates/staged/csv.sql`. Backend-agnostic templates (`@anonymize`, `@dbt_prehook`) have no staged
variant and resolve to the root file for both backends.

### Custom Templates
FlatQuack uses a very simple template language that replaces specific variables when they're placed between double brackets with values from the current execution (e.g., `{{ fq_input_dir }}`). Variable names and values not in the list below may be passed into the template processor using the `--param` command line argument and will be replaced if they appear they the template. This argument may also be used to pass in values that override the values of the built-in variables. Variables not in the list below or passed in as arguments will not be removed by the template engine to support their use in other processing steps such as DBT pipelines.

| name | description |
| --- | --- |
| `fq_input_dir`| Defaults to current working directory |
| `fq_output_dir`| Defaults to current working directory |
| `fq_sql_transform_expression` | SQL transformation generated from the `select` element of the ViewDefinition |
| `fq_where_filter` | SQL generated from the `where` element of the ViewDefinition |
| `fq_sql_input_schema` | SQL schema generated from FHIR elements used in the `select` and `where` elements of the ViewDefinition |
| `fq_sql_flattening_cols` | SQL columns that create the output columns based on the `column` elements in the ViewDefinition |
| `fq_sql_flattening_tables` | SQL joins that create the output columns based on the `column` elements in the ViewDefinition  |
| `fq_vd_name` | The value in the `name` element of the ViewDefinition |
| `fq_vd_resource` | The value in the `resource` element of the ViewDefinition |
| `fq_sql_macros` | DuckDB SQL macros to load before executing a query generated with FlatQuack |

#### Staged backend variables

When `--backend staged` is used, the staged emitter generates most of the query body itself and
exposes it through the following additional variables (used by the templates under
`templates/staged/`). These are empty when the `struct` backend is active.

| name | description |
| --- | --- |
| `fq_staged_with` | The leading `WITH` keyword for the staged query — `WITH` or `WITH RECURSIVE` (the latter when the ViewDefinition contains a `repeat`). |
| `fq_staged_src` | The `SELECT` column list of the first (`src`) CTE that reads the source rows. |
| `fq_staged_src_materialized` | `MATERIALIZED ` (or empty) — applied to the `src` CTE when required by the chosen `--root-key` strategy. |
| `fq_staged_tail` | The remaining staged CTE chain and the final `SELECT` that produces the flattened rows. Placed immediately after the closing `)` of the `src` CTE. |
| `fq_staged_macros` | View-specific DuckDB macros emitted by the staged backend. Must appear before the query (in addition to `fq_sql_macros`), as they cannot be hoisted into a shared prehook. |

## Macros (--macros parameter)
As an experimental feature, DuckDB macros or native DuckDB functions that accept and return a scalar value may be used in ViewDefinitions processed with FlatQuack. This feature enables custom data transformations, anonymization, and other scalar processing functions to be applied to FHIR data during flattening.

### Writing Macros
Macros are written using standard DuckDB SQL syntax and must:
- Use the `CREATE OR REPLACE MACRO` statement
- Accept and return scalar values (not tables or complex objects)
- Be stored in `.sql` files with statements ending in semicolons

Example macro that extracts the year portion of a date string:
```sql
CREATE OR REPLACE MACRO anon_date_to_year(date) AS (
    CASE
        WHEN date IS NULL OR len(date) < 4 THEN NULL
        ELSE substring(date, 1, 4)
    END
);
```

See [anonymize.sql](/templates/anonymize.sql) for additional examples of macros for data anonymization.

### Using the `_invoke` FHIRPath Function
Call macros or native DuckDB functions in ViewDefinition FHIRPath expressions using the `_invoke()` function. The first parameter is the macro or function name (as a string), followed by any parameters the macro requires in addition to the current value of the path which will always be passed in as the first parameter. All parameters must be scalar literal values (strings, numbers, booleans).

Examples:
```json
{
  "column": [{
    "name": "birthYear",
    "path": "birthDate._invoke('anon_date_to_year')"
  }]
}
```

The `_invoke` function can be used:
- On scalar or array values (arrays are mapped over automatically)
- With multiple parameters: `id._invoke('substring', 1, 2)`
- Inside `where()` clauses: `address.where(country._invoke('anon_is_usa'))`
- Within `_forEach` expressions for complex transformations

### Loading Macros via Command Line
Use the `--macros` parameter to load macro files when running FlatQuack. This parameter accepts:
- **File paths**: `--macros ./my-macros.sql`
- **Directory paths**: `--macros ./macros/` (loads all `.sql` files in the directory)
- **Template references**: `--macros @anonymize` (references `templates/anonymize.sql`)
- **Multiple sources**: Repeat the parameter to load from multiple locations

## Generating a FHIR Schema
The schema for FHIR R4 is included with FlatQuack, but you may want to execute ViewDefinition files against other FHIR versions as well. To do this you can generate schema files for those version and pass them in with the `--schema-file` command line argument.

To generate a schema:
1. Download and decompress the FHIR definitions in JSON format from `https://hl7.org/fhir/downloads.html` (or the corresponding URL for the FHIR version you want to use).
2. Run the script:
    ```bash
    bun ./scripts/build-fhir-schema.js {path to FHIR definitions} {output file path}
    ```
The script accepts two positional parameters:
- The path to the directory where the FHIR definition files in JSON format are located (e.g., `../fhir/R4`) 
- The path for the schema file (e.g. `../schemas/fhir-schema-r4.json`)

## Potential Future Development

- [ ] Value Set support 
- [ ] Unions with nested select elements
- [ ] Constants in ViewDefinitions
- [ ] Boundary functions in FHIR Path expressions
- [ ] Watch command line mode for exploratory queries

## Contributing

### Pull Requests
Pull requests are very welcome! Apart from minor bug fixes, please start by opening [an issue](/issues) to discuss your plans and make sure they're aligned with other work being done on the project.

### Running the tests
```bash
bun test
```

### Generating specification test output file
1. Ensure that the test files in the `./tests/spec-tests` directory are up to date
2. Run `bun ./scripts/build-test-output.js`.
3. Output file is written as `flatquack_test_output.json`

## Support

As an open source project, support is provided for FlatQuack on a best effort basis. Interested in commercial support, training, or sponsoring the addition of a feature to the app? Please get in touch - Dan (at) CentralSquareSolutions.com.