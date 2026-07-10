{{fq_sql_macros}}
{{fq_sql_view_macros}}
{{fq_sql_with}} {{fq_sql_input}} AS MATERIALIZED (
	SELECT * FROM read_json_auto(
		'{{fq_input_dir}}/**/*{{fq_vd_resource}}*.ndjson'
		{{fq_sql_input_schema}}
	)
	{{fq_sql_where}}
	LIMIT 10
),
{{fq_sql_pipeline}}
SELECT {{fq_sql_output_columns}} FROM {{fq_sql_output}}
