# =====================================================================
# RFM segmentation -- base R implementation.
#
# Deliberately base R only: no dplyr, no data.table. The lab runs this
# inside webR (R compiled to WebAssembly) in the visitor's browser, where
# a CRAN mirror may not be reachable. Depending on nothing but `base` and
# `stats` is what makes the page work offline and on first load.
#
# This is a re-implementation, not a translation: it must agree row-for-row
# with analytics/rfm.py and sql/02_rfm.sql. tests/test_parity.py enforces it.
# =====================================================================

RFM_QUANTILES <- c(0.20, 0.40, 0.60, 0.80)

# Tie-safe scoring. Scores compare VALUES to fixed breakpoints rather than
# using rank buckets, so tied customers always receive the same score.
# R's quantile(type = 7) is the same estimator as numpy's method="linear"
# and DuckDB's quantile_cont, which is why all three implementations agree.
quantile_breaks <- function(x, probs = RFM_QUANTILES) {
  unname(stats::quantile(as.numeric(x), probs = probs, type = 7, names = FALSE))
}

score_ascending <- function(x, breaks) {           # higher value -> higher score
  1L + as.integer(x > breaks[1]) + as.integer(x > breaks[2]) +
       as.integer(x > breaks[3]) + as.integer(x > breaks[4])
}

score_descending <- function(x, breaks) {          # lower value -> higher score
  5L - as.integer(x > breaks[1]) - as.integer(x > breaks[2]) -
       as.integer(x > breaks[3]) - as.integer(x > breaks[4])
}

# First match wins; exhaustive over r,f in 1..5 (asserted in the test suite).
assign_segment <- function(r, f) {
  out <- character(length(r))
  out[]                              <- "Lost"
  out[r == 2L & f == 1L]             <- "Hibernating"
  out[r == 2L & f >= 2L]             <- "At risk"
  out[r == 3L & f <= 2L]             <- "Need attention"
  out[r == 4L & f == 1L]             <- "Promising"
  out[r == 5L & f == 1L]             <- "New customers"
  out[r >= 4L & f == 2L]             <- "Potential loyalists"
  out[r >= 3L & f >= 3L]             <- "Loyal customers"
  out[f >= 4L & r <= 2L]             <- "Cannot lose them"
  out[r >= 4L & f >= 4L]             <- "Champions"
  out
}

#' @param sales data.frame with customer_id, invoice, invoice_day (Date),
#'              line_revenue
#' @param as_of reference date for recency
rfm_build <- function(sales, as_of = as.Date("2011-12-10")) {
  sales <- sales[!is.na(sales$customer_id), , drop = FALSE]
  cust  <- factor(sales$customer_id)

  last_day  <- tapply(as.integer(sales$invoice_day), cust, max)
  frequency <- tapply(sales$invoice, cust, function(v) length(unique(v)))
  monetary  <- round(tapply(sales$line_revenue, cust, sum), 2)

  out <- data.frame(
    customer_id  = as.integer(levels(cust)),
    recency_days = as.integer(as.integer(as_of) - as.integer(last_day)),
    frequency    = as.integer(frequency),
    monetary     = as.numeric(monetary),
    stringsAsFactors = FALSE
  )

  rb <- quantile_breaks(out$recency_days)
  fb <- quantile_breaks(out$frequency)
  mb <- quantile_breaks(out$monetary)

  out$r_score  <- score_descending(out$recency_days, rb)
  out$f_score  <- score_ascending(out$frequency,     fb)
  out$m_score  <- score_ascending(out$monetary,      mb)
  out$rfm_cell <- paste0(out$r_score, out$f_score, out$m_score)
  out$segment  <- assign_segment(out$r_score, out$f_score)

  out[order(out$customer_id), ]
}

rfm_summarise <- function(rfm) {
  agg <- function(f) tapply(rfm[[f]], rfm$segment, mean)
  seg <- sort(unique(rfm$segment))
  data.frame(
    segment        = seg,
    customers      = as.integer(table(rfm$segment)[seg]),
    avg_recency    = round(agg("recency_days")[seg], 2),
    avg_frequency  = round(agg("frequency")[seg], 2),
    avg_monetary   = round(agg("monetary")[seg], 2),
    total_monetary = round(tapply(rfm$monetary, rfm$segment, sum)[seg], 2),
    row.names = NULL, stringsAsFactors = FALSE
  )
}
