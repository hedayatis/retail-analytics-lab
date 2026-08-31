# =====================================================================
# Acquisition-cohort retention -- base R implementation.
# Mirrors analytics/cohort.py and sql/03_cohort_retention.sql exactly.
#
# The two decisions that make cohort tables wrong elsewhere are made
# explicitly here:
#   1. month_index is calendar-month arithmetic (12*dy + dm), never
#      day-difference / 30.44, which drifts by a whole index over 2 years.
#   2. Right-censored cells are DROPPED, not zero-filled: a cohort acquired
#      last month has not failed to retain at M+6, it simply cannot be read.
# =====================================================================

month_ordinal <- function(d) {
  lt <- as.POSIXlt(d)
  (lt$year + 1900L) * 12L + (lt$mon + 1L)
}

ordinal_to_label <- function(o) {
  sprintf("%04d-%02d", (o - 1L) %/% 12L, (o - 1L) %% 12L + 1L)
}

#' @param sales data.frame with customer_id and invoice_day (Date)
#' @param max_index highest month index to report
cohort_build <- function(sales, max_index = 12L) {
  s <- sales[!is.na(sales$customer_id), c("customer_id", "invoice_day")]
  s$month_ord <- month_ordinal(s$invoice_day)

  # distinct (customer, month) activity
  act <- unique(data.frame(customer_id = s$customer_id,
                           month_ord   = s$month_ord))
  cohort_ord <- tapply(act$month_ord, factor(act$customer_id), min)
  map <- data.frame(customer_id = as.integer(names(cohort_ord)),
                    cohort_ord  = as.integer(cohort_ord))
  act <- merge(act, map, by = "customer_id")
  act$month_index <- act$month_ord - act$cohort_ord

  last_ord <- max(act$month_ord)
  sizes <- as.data.frame(table(map$cohort_ord), stringsAsFactors = FALSE)
  names(sizes) <- c("cohort_ord", "cohort_size")
  sizes$cohort_ord  <- as.integer(sizes$cohort_ord)
  sizes$cohort_size <- as.integer(sizes$cohort_size)

  grid <- expand.grid(cohort_ord = sizes$cohort_ord,
                      month_index = 0:max_index)
  grid <- merge(grid, sizes, by = "cohort_ord")
  grid <- grid[grid$month_index <= (last_ord - grid$cohort_ord), , drop = FALSE]

  key <- paste(act$cohort_ord, act$month_index, sep = "_")
  counts <- tapply(act$customer_id, key, function(v) length(unique(v)))
  grid$active_customers <- as.integer(
    counts[paste(grid$cohort_ord, grid$month_index, sep = "_")])
  grid$active_customers[is.na(grid$active_customers)] <- 0L

  grid$retention_pct <- round(100 * grid$active_customers / grid$cohort_size, 2)
  grid$cohort_month  <- ordinal_to_label(grid$cohort_ord)

  out <- grid[, c("cohort_month", "month_index", "cohort_size",
                  "active_customers", "retention_pct")]
  out[order(out$cohort_month, out$month_index), ]
}

#' Pivot the tidy table into the triangular heat-map layout.
cohort_matrix <- function(retention) {
  wide <- reshape(retention[, c("cohort_month", "month_index", "retention_pct")],
                  idvar = "cohort_month", timevar = "month_index",
                  direction = "wide")
  names(wide) <- sub("retention_pct\\.", "M+", names(wide))
  wide[order(wide$cohort_month), ]
}
