{{fq_sql_with}} {{fq_sql_input}} AS (
	SELECT * FROM {{ source('fhir_db', '{{fq_vd_resource}}') }}
	{{fq_sql_where}}
),
{{fq_sql_pipeline}}
SELECT {{fq_sql_output_columns}} FROM {{fq_sql_output}}
