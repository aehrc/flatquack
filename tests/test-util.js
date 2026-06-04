import { DuckDBInstance } from "@duckdb/node-api";
import macros from "../templates/duck-macros";

export const testQueryTemplate = `
	WITH transformed AS (
		SELECT {{fq_sql_transform_expression}}
		FROM read_json_auto(
			'{{test_file_path}}'
			{{fq_sql_input_schema}}
		)
		{{fq_where_filter}}
	)
	SELECT {{fq_sql_flattening_cols}}
	FROM transformed
	{{fq_sql_flattening_tables}}
`

// Staged backend (SPEC_hybrid): the first CTE reuses the existing source mechanism;
// the builder emits the rest of the query into {{fq_staged_tail}}.
export const stagedQueryTemplate = `
	WITH src AS {{fq_staged_src_materialized}}(
		SELECT {{fq_staged_src}}
		FROM read_json_auto(
			'{{test_file_path}}'
			{{fq_sql_input_schema}}
		)
		{{fq_where_filter}}
	){{fq_staged_tail}}
`

class DuckDBConn {
	constructor(instance, conn) {
		this._instance = instance;
		this._conn = conn;
	}

	async all(sql) {
		const result = await this._conn.runAndReadAll(sql);
		return result.getRowObjectsJS();
	}

	async close() {
		this._instance.closeSync();
	}
}

export async function openMemoryDb() {
	const instance = await DuckDBInstance.create(":memory:");
	const conn = await instance.connect();
	await conn.run(macros);
	return new DuckDBConn(instance, conn);
}

export async function getColumns(db, query) {
	const result = await db._conn.runAndReadAll(query);
	return result.columnNames();
}

export async function executeQuery(db, query) {
	return db.all(query);
}
