export default `
CREATE OR REPLACE MACRO as_list(a) AS if(a IS NULL, [], [a]);		
CREATE OR REPLACE MACRO ifnull2(a, b) AS ifnull(a, b);
CREATE OR REPLACE MACRO slice(a,i) AS a[i];
CREATE OR REPLACE MACRO is_false(a) AS a = false;
CREATE OR REPLACE MACRO is_true(a) AS a = true;
CREATE OR REPLACE MACRO is_null(a) AS a IS NULL;
CREATE OR REPLACE MACRO is_not_null(a) AS a IS NOT NULL;
CREATE OR REPLACE MACRO as_value(a) AS if(len(a) > 1, error('unexpected collection returned'), a[1]);
`.replace(/^\n|\n$/g, "");