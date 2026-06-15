{{fq_sql_macros}}
{{fq_staged_macros}}
COPY (
	{{fq_staged_with}} src AS {{fq_staged_src_materialized}}(
		SELECT {{fq_staged_src}}
		FROM read_json_auto(
			'{{fq_input_dir}}/**/*{{fq_vd_resource}}*.ndjson'
			{{fq_sql_input_schema}}
		)
		{{fq_where_filter}}
	){{fq_staged_tail}}
)
TO '{{fq_output_dir}}/{{fq_vd_name}}.ndjson'
(FORMAT JSON);
