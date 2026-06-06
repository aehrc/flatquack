{{fq_sql_macros}}

COPY (
	WITH transformed AS (
		SELECT {{fq_sql_transform_expression}} 
		FROM read_json_auto(
			'{{fq_input_dir}}/**/*{{fq_vd_resource}}*.ndjson'
			{{fq_sql_input_schema}}
		)
		{{fq_where_filter}}
	)
	SELECT {{fq_sql_flattening_cols}}
	FROM transformed
	{{fq_sql_flattening_tables}}
)

TO '{{fq_output_dir}}/{{fq_vd_name}}.csv' 
(FORMAT CSV, DELIMITER ',', HEADER);