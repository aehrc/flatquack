#!/usr/bin/env bun
// Generate struct-backend (default flatquack) SQL for a ViewDefinition, with a
// {{SOURCE}} placeholder so it plugs straight into benchmark/explain.sh.
import fs from "fs";
import {templateToQuery} from "../src/query-builder.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";
import {format} from "sql-formatter";

const STRUCT_TEMPLATE = `{{fq_sql_macros}}
WITH transformed AS (
  SELECT {{fq_sql_transform_expression}}
  FROM read_json_auto(
    '{{SOURCE}}'
    {{fq_sql_input_schema}}
  )
  {{fq_where_filter}}
)
SELECT {{fq_sql_flattening_cols}}
FROM transformed
{{fq_sql_flattening_tables}}`;

const viewPath = process.argv[2];
const outPath = process.argv[3];
const depth = process.argv[4] ? parseInt(process.argv[4], 10) : 10;
if (!viewPath || !outPath) {
  console.error("usage: bun scripts/gen-struct.js <view.json> <out.sql> [repeat-depth=10]");
  process.exit(1);
}

const view = JSON.parse(fs.readFileSync(viewPath, "utf-8"));
// backend="struct" (default), rootKey n/a, repeatDepth=depth; filterByResourceType=true.
const sql = templateToQuery(
  view, fhirSchema, STRUCT_TEMPLATE, [], false, true, null, null, "struct", "natural", depth
);
let out;
try { out = format(sql, {language: "duckdb", linesBetweenQueries: 0}); }
catch { out = sql; }
fs.writeFileSync(outPath, out + "\n");
console.log("wrote", outPath, "(depth", depth + ")");
