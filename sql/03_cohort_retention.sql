-- =====================================================================
-- Acquisition-cohort retention -- SQL implementation.
-- Mirrors src/retail_lab/analytics/cohort.py; asserted equal in tests.
--
-- month_index uses calendar-month arithmetic (12*dy + dm), never day counts
-- divided by 30.44, which drifts a whole index over a two-year window.
-- Right-censored cells are omitted, not zero-filled.
-- =====================================================================

WITH activity AS (
    SELECT DISTINCT
        customer_id,
        (EXTRACT(year FROM invoice_day) * 12
         + EXTRACT(month FROM invoice_day))::BIGINT AS month_ord
    FROM fct_sales
    WHERE customer_id IS NOT NULL
),
first_month AS (
    SELECT customer_id, MIN(month_ord) AS cohort_ord
    FROM activity GROUP BY customer_id
),
bounds AS (SELECT MAX(month_ord) AS last_ord FROM activity),
sizes AS (
    SELECT cohort_ord, COUNT(*) AS cohort_size
    FROM first_month GROUP BY cohort_ord
),
grid AS (
    SELECT s.cohort_ord, s.cohort_size, i.month_index
    FROM sizes s
    CROSS JOIN (SELECT UNNEST(GENERATE_SERIES(0, 12)) AS month_index) i
    CROSS JOIN bounds b
    WHERE i.month_index <= b.last_ord - s.cohort_ord      -- drop censored cells
),
active AS (
    SELECT f.cohort_ord,
           (a.month_ord - f.cohort_ord) AS month_index,
           COUNT(DISTINCT a.customer_id) AS active_customers
    FROM activity a
    JOIN first_month f USING (customer_id)
    GROUP BY 1, 2
)
SELECT
    PRINTF('%04d-%02d', ((g.cohort_ord - 1) // 12)::INTEGER,
                       ((g.cohort_ord - 1) % 12 + 1)::INTEGER) AS cohort_month,
    g.month_index,
    g.cohort_size,
    COALESCE(a.active_customers, 0) AS active_customers,
    ROUND(100.0 * COALESCE(a.active_customers, 0) / g.cohort_size, 2) AS retention_pct
FROM grid g
LEFT JOIN active a
       ON a.cohort_ord = g.cohort_ord AND a.month_index = g.month_index
ORDER BY cohort_month, month_index;
