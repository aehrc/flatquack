WITH transformed AS (
	SELECT {{fq_sql_transform_expression}} 
	FROM {{ source('fhir_db', '{{fq_vd_resource}}') }}
	{{fq_where_filter}}
)
SELECT {{fq_sql_flattening_cols}}
FROM transformed
{{fq_sql_flattening_tables}}