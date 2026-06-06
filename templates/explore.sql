{{fq_sql_macros}}

WITH transformed AS (
	SELECT {{fq_sql_transform_expression}} 
	FROM read_json_auto(
		'{{fq_input_dir}}/**/*{{fq_vd_resource}}*.ndjson'
		{{fq_sql_input_schema}}
	)
	{{fq_where_filter}}
	LIMIT 10
)
SELECT {{fq_sql_flattening_cols}}
FROM transformed
{{fq_sql_flattening_tables}}