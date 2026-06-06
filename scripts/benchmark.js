#!/usr/bin/env bun
import fs from 'fs';
import path from 'path';
import duckdb from 'duckdb';
import { templateToQuery } from '../src/query-builder.js';
import fhirSchema from '../schemas/fhir-schema-r4.json';
import macros from '../templates/duck-macros.js';

const ROOT = path.join(import.meta.dir, '..');
const LOCAL = path.join(ROOT, '.local');

const view = JSON.parse(fs.readFileSync(path.join(LOCAL, 'foreach_view.json')));
const nestedView = JSON.parse(fs.readFileSync(path.join(LOCAL, 'nested_foreach_view.json')));

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

function runBenchmark(label, sql, runs = 3) {
    return new Promise((resolve) => {
        const times = [];
        let rowCount = null;

        function runOne(i) {
            if (i >= runs) {
                const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
                const min = Math.min(...times);
                console.log(`${label}: min=${min}ms avg=${avg}ms rows=${rowCount} (${runs} runs)`);
                resolve({ label, min, avg, rowCount, times });
                return;
            }
            const db = new duckdb.Database(':memory:');
            const start = performance.now();
            db.all(sql, (err, res) => {
                const elapsed = Math.round(performance.now() - start);
                if (err) {
                    console.error(`${label} ERROR:`, err.message);
                    db.close();
                    resolve({ label, error: err.message });
                    return;
                }
                times.push(elapsed);
                rowCount = res.length;
                db.close(() => runOne(i + 1));
            });
        }
        runOne(0);
    });
}

const ndjsonSql = templateToQuery(view, fhirSchema, ndjsonTemplate, [
    ['fq_input_dir', LOCAL],
], false, true);

// parquet files already scoped to one resource type, so no resourceType filter
const parquetSql = templateToQuery(view, fhirSchema, parquetTemplate, [
    ['fq_input_dir', ROOT],
], false, false);

const nestedNdjsonSql = templateToQuery(nestedView, fhirSchema, ndjsonTemplate, [
    ['fq_input_dir', LOCAL],
], false, true);

const nestedParquetSql = templateToQuery(nestedView, fhirSchema, parquetTemplate, [
    ['fq_input_dir', ROOT],
], false, false);

console.log('=== NDJSON SQL ===');
console.log(ndjsonSql);
console.log('\n=== Parquet SQL ===');
console.log(parquetSql);
const RUNS = 3;
console.log('\n=== Benchmarks ===');
console.log('-- unionAll view --');
await runBenchmark('ndjson ', ndjsonSql, RUNS);
await runBenchmark('parquet', parquetSql, RUNS);
console.log('-- nested forEach view --');
await runBenchmark('ndjson ', nestedNdjsonSql, RUNS);
await runBenchmark('parquet', nestedParquetSql, RUNS);
