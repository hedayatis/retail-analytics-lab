-- =====================================================================
-- Star schema for the Online Retail II lab.
--
-- Grain declarations (the thing most schemas leave implicit):
--   fct_sales    : one row per sold invoice line
--   fct_returns  : one row per returned/cancelled invoice line
--   dim_customer : one row per identified customer
--   dim_product  : one row per stock code
--   dim_date     : one row per calendar day in the trading window
--
-- Built by warehouse.py, which registers the cleaned pandas frames as
-- `stg_sales` / `stg_returns` before running this script.
-- =====================================================================

CREATE OR REPLACE TABLE fct_sales AS
SELECT
    sales_line_id::BIGINT      AS sales_line_id,
    invoice::VARCHAR           AS invoice,
    stock_code::VARCHAR        AS stock_code,
    description::VARCHAR       AS description,
    quantity::INTEGER          AS quantity,
    unit_price::DECIMAL(12,4)  AS unit_price,
    line_revenue::DECIMAL(14,2) AS line_revenue,
    invoice_date::TIMESTAMP    AS invoice_date,
    invoice_date::DATE         AS invoice_day,
    invoice_month::VARCHAR     AS invoice_month,
    customer_id::INTEGER       AS customer_id,
    country::VARCHAR           AS country
FROM stg_sales;

CREATE OR REPLACE TABLE fct_returns AS
SELECT
    invoice::VARCHAR           AS invoice,
    stock_code::VARCHAR        AS stock_code,
    quantity::INTEGER          AS quantity,
    unit_price::DECIMAL(12,4)  AS unit_price,
    line_value::DECIMAL(14,2)  AS line_value,
    invoice_date::TIMESTAMP    AS invoice_date,
    invoice_date::DATE         AS invoice_day,
    customer_id::INTEGER       AS customer_id,
    country::VARCHAR           AS country,
    is_cancellation::BOOLEAN   AS is_cancellation
FROM stg_returns;

-- One row per identified customer. Country is the modal country on their
-- orders: a handful of customers appear under more than one, and picking
-- deterministically beats letting a join multiply their revenue.
CREATE OR REPLACE TABLE dim_customer AS
WITH per_customer AS (
    SELECT
        customer_id,
        MIN(invoice_day)                    AS first_purchase_date,
        MAX(invoice_day)                    AS last_purchase_date,
        MIN(invoice_month)                  AS cohort_month,
        COUNT(DISTINCT invoice)             AS n_orders,
        SUM(line_revenue)                   AS lifetime_revenue,
        SUM(quantity)                       AS lifetime_units
    FROM fct_sales
    WHERE customer_id IS NOT NULL
    GROUP BY customer_id
),
modal_country AS (
    SELECT customer_id, country
    FROM (
        SELECT customer_id, country, COUNT(*) AS n,
               ROW_NUMBER() OVER (PARTITION BY customer_id
                                  ORDER BY COUNT(*) DESC, country) AS rn
        FROM fct_sales
        WHERE customer_id IS NOT NULL
        GROUP BY customer_id, country
    ) WHERE rn = 1
)
SELECT p.*, m.country,
       DATE_DIFF('day', p.first_purchase_date, p.last_purchase_date) AS tenure_days
FROM per_customer p
JOIN modal_country m USING (customer_id);

CREATE OR REPLACE TABLE dim_product AS
SELECT
    stock_code,
    -- descriptions drift over time for the same code; take the most frequent
    MODE(description)                       AS description,
    COUNT(DISTINCT invoice)                 AS n_invoices,
    SUM(quantity)                           AS units_sold,
    SUM(line_revenue)                       AS revenue,
    MEDIAN(unit_price)                      AS median_unit_price,
    MIN(invoice_day)                        AS first_sold,
    MAX(invoice_day)                        AS last_sold
FROM fct_sales
GROUP BY stock_code;

CREATE OR REPLACE TABLE dim_date AS
SELECT
    d::DATE                                          AS date_day,
    EXTRACT(year  FROM d)::INTEGER                   AS year,
    EXTRACT(month FROM d)::INTEGER                   AS month_num,
    STRFTIME(d, '%Y-%m')                             AS year_month,
    STRFTIME(d, '%b')                                AS month_name,
    EXTRACT(quarter FROM d)::INTEGER                 AS quarter,
    EXTRACT(isodow  FROM d)::INTEGER                 AS iso_weekday,
    STRFTIME(d, '%a')                                AS weekday_name,
    (EXTRACT(isodow FROM d) >= 6)                    AS is_weekend
FROM generate_series(
        (SELECT MIN(invoice_day) FROM fct_sales),
        (SELECT MAX(invoice_day) FROM fct_sales),
        INTERVAL 1 DAY) AS t(d);
