#!/usr/bin/env bun
// Generate hybrid-typed (staged backend) SQL for a ViewDefinition, with a
// {{SOURCE}} placeholder so it plugs straight into benchmark/explain.sh.
import fs from "fs";
import {templateToQuery} from "../src/query-builder.js";
import fhirSchema from "../schemas/fhir-schema-r4.json";
import macros from "../templates/duck-macros.js";
import {format} from "sql-formatter";

const STAGED_TEMPLATE = `{{fq_staged_macros}}{{fq_staged_with}} src AS {{fq_staged_src_materialized}}(
  SELECT {{fq_staged_src}}
  FROM read_json_auto(
    '{{SOURCE}}'
    {{fq_sql_input_schema}}
  )
  {{fq_where_filter}}
){{fq_staged_tail}}`;

const viewPath = process.argv[2];
const outPath = process.argv[3];
// Optional 3rd arg: root-fork key mode (natural|uuid, default natural).
const rootKey = process.argv[4] || "natural";
if (!viewPath || !outPath) {
  console.error("usage: bun scripts/gen-staged.js <view.json> <out.sql> [natural|uuid]");
  process.exit(1);
}

const view = JSON.parse(fs.readFileSync(viewPath, "utf-8"));
// filterByResourceType=true -> emits WHERE resourceType = '<resource>'
const sql = templateToQuery(
  view, fhirSchema, STAGED_TEMPLATE, [], false, true, null, null, "staged", rootKey
);
let out;
try { out = format(sql, {language: "duckdb", linesBetweenQueries: 0}); }
catch { out = sql; }
// Prepend the runtime macros (explain.sh runs raw SQL with no JS layer). They
// must precede the single top-level `WITH` line that explain.sh keys off of.
const macroSql = format(macros, {language: "duckdb", linesBetweenQueries: 0});
fs.writeFileSync(outPath, macroSql + "\n" + out + "\n");
console.log("wrote", outPath);
