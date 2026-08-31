"""Acquisition-cohort retention.

A cohort is the calendar month of a customer's first *identified* purchase.
``month_index`` counts whole calendar months since that month, so index 0 is
the acquisition month itself (always 100%) and index k is "still buying k
months later".

Two details that are usually got wrong and are handled explicitly here:

* **Month arithmetic, not 30-day arithmetic.** ``(activity - cohort)`` in days
  divided by 30.44 drifts by a whole index over a two-year window. The index is
  computed as ``12*(y2-y1) + (m2-m1)`` on calendar fields.
* **Right-censoring.** A cohort acquired in the last month of the window has no
  chance to appear at index 6. Reporting it as 0% retention is a lie, so cells
  beyond a cohort's observable horizon are omitted rather than zero-filled, and
  ``observable`` records how far each cohort can legitimately be read.
"""
from __future__ import annotations

import pandas as pd

from ..logging_setup import get_logger, stage

log = get_logger("cohort")


def _month_ordinal(s: pd.Series) -> pd.Series:
    """Map a datetime to a monotonic month number (year*12 + month)."""
    return (s.dt.year * 12 + s.dt.month).astype("int64")


def build(sales: pd.DataFrame, max_index: int = 12) -> pd.DataFrame:
    """Return a tidy retention table: one row per (cohort_month, month_index)."""
    with stage(log, "cohort"):
        df = sales.loc[sales["customer_id"].notna(),
                       ["customer_id", "invoice_date"]].copy()
        df["month_ord"] = _month_ordinal(df["invoice_date"])

        first = (df.groupby("customer_id", observed=True)["month_ord"]
                   .min().rename("cohort_ord").reset_index())
        df = df.merge(first, on="customer_id")
        df["month_index"] = (df["month_ord"] - df["cohort_ord"]).astype("int64")

        last_ord = int(df["month_ord"].max())
        sizes = (first.groupby("cohort_ord", observed=True)["customer_id"]
                      .nunique().rename("cohort_size").reset_index())

        active = (df.drop_duplicates(["customer_id", "cohort_ord", "month_index"])
                    .groupby(["cohort_ord", "month_index"], observed=True)["customer_id"]
                    .nunique().rename("active_customers").reset_index())

        grid = (sizes.assign(key=1)
                     .merge(pd.DataFrame({"month_index": range(0, max_index + 1),
                                          "key": 1}), on="key")
                     .drop(columns="key"))
        out = grid.merge(active, on=["cohort_ord", "month_index"], how="left")
        out["active_customers"] = out["active_customers"].fillna(0).astype("int64")

        # right-censoring: drop cells the data cannot speak to
        out["observable"] = last_ord - out["cohort_ord"]
        out = out.loc[out["month_index"] <= out["observable"]].copy()

        out["retention_pct"] = (100 * out["active_customers"]
                                / out["cohort_size"]).round(2)
        out["cohort_month"] = out["cohort_ord"].map(_ord_to_label).astype("string")
        out = (out[["cohort_month", "month_index", "cohort_size",
                    "active_customers", "retention_pct"]]
               .sort_values(["cohort_month", "month_index"])
               .reset_index(drop=True))
        log.info("%d cohorts, %s observable cells, horizon %d months",
                 out["cohort_month"].nunique(), f"{len(out):,}", max_index)
    return out


def _ord_to_label(o: int) -> str:
    year, month = divmod(int(o) - 1, 12)
    return f"{year:04d}-{month + 1:02d}"


def to_matrix(retention: pd.DataFrame) -> pd.DataFrame:
    """Pivot the tidy table into the familiar triangular heat-map layout."""
    m = retention.pivot(index="cohort_month", columns="month_index",
                        values="retention_pct")
    m.columns = [f"M+{c}" for c in m.columns]
    sizes = (retention.loc[retention["month_index"] == 0]
             .set_index("cohort_month")["cohort_size"])
    return m.assign(cohort_size=sizes).reset_index()
