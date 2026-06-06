#!/usr/bin/env bun
/**
 * Run a flatquack benchmark against ndjson and/or parquet test datasets.
 *
 * Usage:
 *   bun run scripts/run-benchmark.js \
 *     --view .local/foreach_view.json \
 *     --label baseline \
 *     [--datasource ndjson|parquet|both]  (default: ndjson)
 *     [--runs N]                           (default: 3)
 */
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { DuckDBInstance } from '@duckdb/node-api';
import { templateToQuery } from '../src/query-builder.js';
import fhirSchema from '../schemas/fhir-schema-r4.json';

const ROOT = path.join(import.meta.dir, '..');
const LOCAL = path.join(ROOT, '.local');
const RESULTS_DIR = path.join(LOCAL, 'benchmark_results');

const { values: args } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        view:       { type: 'string' },
        label:      { type: 'string' },
        datasource: { type: 'string', default: 'ndjson' },
        runs:       { type: 'string',  default: '3' },
    },
});

if (!args.view || !args.label) {
    console.error('Usage: bun run scripts/run-benchmark.js --view <path> --label <label> [--datasource ndjson|parquet|both] [--runs N]');
    process.exit(1);
}

const RUNS = parseInt(args.runs, 10);
const datasource = args.datasource; // 'ndjson' | 'parquet' | 'both'

const viewPath = path.resolve(args.view);
const view = JSON.parse(fs.readFileSync(viewPath));

const ndjsonTemplate = `
{{fq_sql_macros}}
WITH transformed AS (
    SELECT {{fq_sql_transform_expression}} AS result
    FROM read_json_auto(
        '{{fq_input_dir}}/**/*{{fq_vd_resource}}*.ndjson'
        {{fq_sql_input_schema}}
    )
    {{fq_where_filter}}
)
SELECT {{fq_sql_flattening_cols}}
FROM transformed
{{fq_sql_flattening_tables}}
`;

const parquetTemplate = `
{{fq_sql_macros}}
WITH _fq_source AS (
    SELECT * FROM read_parquet('{{fq_input_dir}}/.local/parquet/{{fq_vd_resource}}.*.parquet')
    {{fq_where_filter}}
),
transformed AS (
    SELECT {{fq_sql_transform_expression}} AS result
    FROM _fq_source
)
SELECT {{fq_sql_flattening_cols}}
FROM transformed
{{fq_sql_flattening_tables}}
`;

function buildSql(template, filterByResourceType, inputDir) {
    return templateToQuery(view, fhirSchema, template, [
        ['fq_input_dir', inputDir],
    ], false, filterByResourceType);
}

async function runOne(sql) {
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    const start = performance.now();
    const result = await conn.runAndReadAll(sql);
    const rows = result.getRowObjectsJS();
    const elapsed = Math.round(performance.now() - start);
    instance.closeSync();
    return { elapsed, rowCount: rows.length };
}

async function runBenchmark(label, sql) {
    const times = [];
    let rowCount = null;
    for (let i = 0; i < RUNS; i++) {
        const r = await runOne(sql);
        times.push(r.elapsed);
        rowCount = r.rowCount;
    }
    const min = Math.min(...times);
    const avg = Math.round(times.reduce((a, b) => a + b) / times.length);
    return { label, min, avg, rowCount, runs: RUNS, times };
}

// Build SQL queries for requested datasources
const queries = [];
if (datasource === 'ndjson' || datasource === 'both') {
    queries.push({ name: 'ndjson', sql: buildSql(ndjsonTemplate, true, LOCAL) });
}
if (datasource === 'parquet' || datasource === 'both') {
    // parquet files are already resource-scoped, no resourceType filter
    queries.push({ name: 'parquet', sql: buildSql(parquetTemplate, false, ROOT) });
}

console.log(`\nBenchmark: ${args.label}  view: ${path.basename(viewPath)}  datasource: ${datasource}  runs: ${RUNS}\n`);

const results = [];
for (const q of queries) {
    const r = await runBenchmark(q.name, q.sql);
    results.push(r);
    console.log(`  ${r.label.padEnd(8)} min=${r.min}ms  avg=${r.avg}ms  rows=${r.rowCount}`);
}

// Save results
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(RESULTS_DIR, `${args.label}__${timestamp}.json`);
const record = {
    label: args.label,
    view: path.relative(ROOT, viewPath),
    datasource,
    runs: RUNS,
    timestamp: new Date().toISOString(),
    results,
};
fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
console.log(`\nResults saved to ${path.relative(ROOT, outFile)}`);
