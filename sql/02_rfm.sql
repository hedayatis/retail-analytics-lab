-- =====================================================================
-- RFM segmentation -- SQL implementation.
--
-- This is a deliberate re-implementation of src/retail_lab/analytics/rfm.py
-- (and R/rfm.R). tests/test_parity.py asserts all three agree row-for-row;
-- if this file and the Python drift apart, the test suite fails.
--
-- Scoring is tie-safe by construction: scores are defined by comparing each
-- value against fixed quantile breakpoints, never by NTILE (which splits runs
-- of tied values across bucket boundaries according to row order).
-- =====================================================================

WITH base AS (
    SELECT
        customer_id,
        DATE_DIFF('day', MAX(invoice_day), DATE '2011-12-10') AS recency_days,
        COUNT(DISTINCT invoice)                               AS frequency,
        ROUND(SUM(line_revenue), 2)                           AS monetary
    FROM fct_sales
    WHERE customer_id IS NOT NULL
    GROUP BY customer_id
),
breaks AS (
    SELECT
        QUANTILE_CONT(recency_days, [0.2, 0.4, 0.6, 0.8]) AS rb,
        QUANTILE_CONT(frequency,    [0.2, 0.4, 0.6, 0.8]) AS fb,
        QUANTILE_CONT(monetary,     [0.2, 0.4, 0.6, 0.8]) AS mb
    FROM base
),
scored AS (
    SELECT
        b.customer_id, b.recency_days, b.frequency, b.monetary,
        5 - ( (b.recency_days > k.rb[1])::INT + (b.recency_days > k.rb[2])::INT
            + (b.recency_days > k.rb[3])::INT + (b.recency_days > k.rb[4])::INT ) AS r_score,
        1 + ( (b.frequency    > k.fb[1])::INT + (b.frequency    > k.fb[2])::INT
            + (b.frequency    > k.fb[3])::INT + (b.frequency    > k.fb[4])::INT ) AS f_score,
        1 + ( (b.monetary     > k.mb[1])::INT + (b.monetary     > k.mb[2])::INT
            + (b.monetary     > k.mb[3])::INT + (b.monetary     > k.mb[4])::INT ) AS m_score
    FROM base b CROSS JOIN breaks k
)
SELECT
    customer_id, recency_days, frequency, monetary,
    r_score, f_score, m_score,
    CONCAT(r_score, f_score, m_score) AS rfm_cell,
    CASE                                              -- first match wins
        WHEN r_score >= 4 AND f_score >= 4 THEN 'Champions'
        WHEN f_score >= 4 AND r_score <= 2 THEN 'Cannot lose them'
        WHEN r_score >= 3 AND f_score >= 3 THEN 'Loyal customers'
        WHEN r_score >= 4 AND f_score  = 2 THEN 'Potential loyalists'
        WHEN r_score  = 5 AND f_score  = 1 THEN 'New customers'
        WHEN r_score  = 4 AND f_score  = 1 THEN 'Promising'
        WHEN r_score  = 3 AND f_score <= 2 THEN 'Need attention'
        WHEN r_score  = 2 AND f_score >= 2 THEN 'At risk'
        WHEN r_score  = 2 AND f_score  = 1 THEN 'Hibernating'
        ELSE 'Lost'
    END AS segment
FROM scored
ORDER BY customer_id;
