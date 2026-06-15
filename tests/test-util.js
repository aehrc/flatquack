import duckdb from "duckdb";
import macros from "../templates/duck-macros";

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

export function openMemoryDb() {
	const db = new duckdb.Database(':memory:');
	db.all(macros);
	return db;
}

export function getColumns(db, query) {
	return new Promise( (resolve, reject) => {
		db.prepare(query, (err, stmt) => {
			if (err) return reject(err);
			resolve(stmt.columns().map(c => c.name));
		})
	});
}

export function executeQuery(db, query) {
	return new Promise( (resolve, reject) => {
		db.all(query, (err, res) => {
			if (err) return reject(err);
			resolve(res);
		})
	});
}
