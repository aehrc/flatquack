{{fq_staged_macros}}
{{fq_staged_with}} src AS {{fq_staged_src_materialized}}(
	SELECT {{fq_staged_src}}
	FROM {{ source('fhir_db', '{{fq_vd_resource}}') }}
	{{fq_where_filter}}
){{fq_staged_tail}}
