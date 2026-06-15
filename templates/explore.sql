{{fq_sql_macros}}

WITH src AS {{fq_staged_src_materialized}}(
	SELECT {{fq_staged_src}}
	FROM read_json_auto(
		'{{fq_input_dir}}/**/*{{fq_vd_resource}}*.ndjson'
		{{fq_sql_input_schema}}
	)
	{{fq_where_filter}}
	LIMIT 10
){{fq_staged_tail}}
