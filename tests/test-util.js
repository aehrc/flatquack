import { DuckDBInstance } from "@duckdb/node-api";
import macros from "../templates/duck-macros";

export const testQueryTemplate = `
	WITH transformed AS (
		SELECT {{fq_sql_transform_expression}} AS result
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

class DuckDBConn {
	constructor(instance, conn) {
		this._instance = instance;
		this._conn = conn;
	}

	async all(sql) {
		const result = await this._conn.runAndReadAll(sql);
		return result.getRowObjectsJS();
	}

	async columns(sql) {
		const result = await this._conn.runAndReadAll(sql);
		return result.columnNames();
	}

	async close() {
		this._instance.closeSync();
	}
}

export async function openMemoryDb(macroSql = macros) {
	const instance = await DuckDBInstance.create(":memory:");
	const conn = await instance.connect();
	await conn.run(macroSql);
	return new DuckDBConn(instance, conn);
}

export async function getColumns(db, query) {
	return db.columns(query);
}

export async function executeQuery(db, query) {
	return db.all(query);
}
