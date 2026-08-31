"""RFM segmentation with a *reproducible* scoring rule.

The parity trap
---------------
The obvious way to score RFM is ``NTILE(5)`` in SQL, ``pd.qcut`` in pandas and
``cut(quantile(...))`` in R. All three claim to make quintiles, and all three
disagree on this dataset — because 40% of customers have ``frequency == 1``.
``NTILE`` splits a run of tied values across bucket boundaries by row order, so
two customers with identical behaviour get different scores, and the score you
get depends on how the rows happened to be sorted.

The rule used here is tie-safe and defined on *values*, not on row positions:

    breaks = quantile(x, [.20, .40, .60, .80])       (type-7 / linear interp.)
    ascending  score = 1 + #{b in breaks : x >  b}   (higher value  -> higher score)
    descending score = 5 - #{b in breaks : x >  b}   (lower  value  -> higher score)

Every customer with the same value gets the same score, in every language.
The cost is that quintiles are no longer exactly equal-sized when ties straddle
a boundary — which is the honest outcome, not a defect.
"""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from ..config import SETTINGS
from ..logging_setup import get_logger, stage

log = get_logger("rfm")

QUANTILES = (0.20, 0.40, 0.60, 0.80)

# Segment ladder: first matching rule wins. Every (r, f) pair in 1..5 x 1..5 is
# covered; the mapping is exhaustive by construction and unit-tested as such.
SEGMENT_RULES: tuple[tuple[str, str], ...] = (
    ("Champions",           "r >= 4 and f >= 4"),
    ("Cannot lose them",    "f >= 4 and r <= 2"),
    ("Loyal customers",     "r >= 3 and f >= 3"),
    ("Potential loyalists", "r >= 4 and f == 2"),
    ("New customers",       "r == 5 and f == 1"),
    ("Promising",           "r == 4 and f == 1"),
    ("Need attention",      "r == 3 and f <= 2"),
    ("At risk",             "r == 2 and f >= 2"),
    ("Hibernating",         "r == 2 and f == 1"),
    ("Lost",                "r == 1"),
)


def quantile_breaks(x: pd.Series, qs: tuple[float, ...] = QUANTILES) -> list[float]:
    """Type-7 quantiles — the default in both R's ``quantile`` and numpy."""
    return [float(np.quantile(x.to_numpy(dtype="float64"), q, method="linear"))
            for q in qs]


def score_ascending(x: pd.Series, breaks: list[float]) -> pd.Series:
    """Higher value -> higher score (frequency, monetary)."""
    out = pd.Series(1, index=x.index, dtype="int64")
    for b in breaks:
        out += (x > b).astype("int64")
    return out


def score_descending(x: pd.Series, breaks: list[float]) -> pd.Series:
    """Lower value -> higher score (recency in days)."""
    out = pd.Series(5, index=x.index, dtype="int64")
    for b in breaks:
        out -= (x > b).astype("int64")
    return out


def assign_segment(r: int, f: int) -> str:
    for name, expr in SEGMENT_RULES:
        if eval(expr, {"__builtins__": {}}, {"r": int(r), "f": int(f)}):
            return name
    raise ValueError(f"segment ladder is not exhaustive for r={r}, f={f}")


def build(sales: pd.DataFrame, as_of: date | None = None) -> pd.DataFrame:
    """Compute per-customer RFM from cleaned sales lines.

    Only identified customers are scored; the 22.8% of lines with no customer id
    are genuine guest checkouts and cannot be attributed to a person.
    """
    as_of = as_of or SETTINGS.params.as_of
    with stage(log, "rfm"):
        df = sales.loc[sales["customer_id"].notna()]
        ref = pd.Timestamp(as_of)

        base = (df.groupby("customer_id", observed=True)
                  .agg(last_purchase=("invoice_date", "max"),
                       frequency=("invoice", "nunique"),
                       monetary=("line_revenue", "sum"))
                  .reset_index())
        # Recency is measured in whole CALENDAR days between the reference date
        # and the day of the last purchase. Subtracting raw timestamps instead
        # would floor a 2011-12-09 13:00 purchase to 0 days from a 2011-12-10
        # reference, while the SQL and R implementations (which work on dates)
        # would say 1 -- a one-day disagreement that silently moves customers
        # across the r_score boundary. Normalising to midnight fixes it at the
        # definition, not with a tolerance in the parity test.
        base["last_purchase_day"] = base["last_purchase"].dt.normalize()
        base["recency_days"] = (ref - base["last_purchase_day"]).dt.days.astype("int64")
        base["monetary"] = base["monetary"].round(2)
        base["customer_id"] = base["customer_id"].astype("int64")
        base["frequency"] = base["frequency"].astype("int64")

        breaks = {
            "recency": quantile_breaks(base["recency_days"]),
            "frequency": quantile_breaks(base["frequency"]),
            "monetary": quantile_breaks(base["monetary"]),
        }
        for k, v in breaks.items():
            log.info("quintile breaks %-9s %s", k, [round(b, 3) for b in v])

        base["r_score"] = score_descending(base["recency_days"], breaks["recency"])
        base["f_score"] = score_ascending(base["frequency"], breaks["frequency"])
        base["m_score"] = score_ascending(base["monetary"], breaks["monetary"])
        base["rfm_cell"] = (base["r_score"].astype(str) + base["f_score"].astype(str)
                            + base["m_score"].astype(str)).astype("string")
        base["segment"] = [assign_segment(r, f) for r, f in
                           zip(base["r_score"], base["f_score"])]
        base["segment"] = base["segment"].astype("string")

        out = base[["customer_id", "recency_days", "frequency", "monetary",
                    "r_score", "f_score", "m_score", "rfm_cell", "segment"]]
        out = out.sort_values("customer_id").reset_index(drop=True)
        log.info("scored %s customers into %d segments",
                 f"{len(out):,}", out["segment"].nunique())
    return out


def summarise(rfm: pd.DataFrame) -> pd.DataFrame:
    """Segment-level rollup, ordered by the revenue each segment holds."""
    g = (rfm.groupby("segment", observed=True)
            .agg(customers=("customer_id", "size"),
                 avg_recency_days=("recency_days", "mean"),
                 avg_frequency=("frequency", "mean"),
                 avg_monetary=("monetary", "mean"),
                 total_monetary=("monetary", "sum"))
            .reset_index())
    g["pct_customers"] = (100 * g["customers"] / g["customers"].sum()).round(2)
    g["pct_revenue"] = (100 * g["total_monetary"] / g["total_monetary"].sum()).round(2)
    for c in ("avg_recency_days", "avg_frequency", "avg_monetary", "total_monetary"):
        g[c] = g[c].round(2)
    return g.sort_values("total_monetary", ascending=False).reset_index(drop=True)
