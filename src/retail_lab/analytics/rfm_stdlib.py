"""RFM in pure Python -- standard library only, no pandas, no numpy.

Why a fourth implementation
---------------------------
The browser lab runs Python under Pyodide. Pulling pandas into the page costs
the visitor roughly 10 MB and twenty seconds before anything can happen, for a
job that is a group-by over 111k rows. This module does the same work against
``csv`` and ``math`` alone, so the lab is interactive in a couple of seconds.

Keeping it honest: it is held to exactly the same bar as the other three.
tests/test_parity.py asserts pandas == stdlib == SQL == R, row for row, so this
file cannot quietly drift into being "the fast approximate one".
"""
from __future__ import annotations

import csv
import math
from collections import defaultdict
from datetime import date

QUANTILES = (0.20, 0.40, 0.60, 0.80)


def quantile_type7(values: list[float], p: float) -> float:
    """The type-7 estimator, matching R's ``quantile(type = 7)``,
    numpy's ``method="linear"`` and DuckDB's ``quantile_cont``.

    ``values`` must be sorted ascending.
    """
    n = len(values)
    if n == 0:
        raise ValueError("quantile of an empty sequence")
    if n == 1:
        return float(values[0])
    h = (n - 1) * p
    lo = math.floor(h)
    hi = math.ceil(h)
    if lo == hi:
        return float(values[lo])
    return float(values[lo] + (h - lo) * (values[hi] - values[lo]))


def quantile_breaks(values: list[float], probs=QUANTILES) -> list[float]:
    ordered = sorted(values)
    return [quantile_type7(ordered, p) for p in probs]


def score_ascending(x: float, breaks: list[float]) -> int:
    return 1 + sum(1 for b in breaks if x > b)


def score_descending(x: float, breaks: list[float]) -> int:
    return 5 - sum(1 for b in breaks if x > b)


def assign_segment(r: int, f: int) -> str:
    if r >= 4 and f >= 4: return "Champions"
    if f >= 4 and r <= 2: return "Cannot lose them"
    if r >= 3 and f >= 3: return "Loyal customers"
    if r >= 4 and f == 2: return "Potential loyalists"
    if r == 5 and f == 1: return "New customers"
    if r == 4 and f == 1: return "Promising"
    if r == 3 and f <= 2: return "Need attention"
    if r == 2 and f >= 2: return "At risk"
    if r == 2 and f == 1: return "Hibernating"
    return "Lost"


def _to_ordinal(day: str) -> int:
    y, m, d = day.split("-")
    return date(int(y), int(m), int(d)).toordinal()


def build_from_rows(rows, as_of: str = "2011-12-10") -> list[dict]:
    """``rows`` yields mappings with customer_id, invoice, invoice_day, line_revenue."""
    ref = _to_ordinal(as_of)
    last: dict[int, int] = {}
    invoices: dict[int, set] = defaultdict(set)
    total: dict[int, float] = defaultdict(float)

    for row in rows:
        cid = int(row["customer_id"])
        day = _to_ordinal(row["invoice_day"])
        if day > last.get(cid, 0):
            last[cid] = day
        invoices[cid].add(row["invoice"])
        total[cid] += float(row["line_revenue"])

    out = [{"customer_id": cid,
            "recency_days": ref - last[cid],
            "frequency": len(invoices[cid]),
            "monetary": round(total[cid], 2)} for cid in sorted(last)]

    rb = quantile_breaks([c["recency_days"] for c in out])
    fb = quantile_breaks([c["frequency"] for c in out])
    mb = quantile_breaks([c["monetary"] for c in out])

    for c in out:
        c["r_score"] = score_descending(c["recency_days"], rb)
        c["f_score"] = score_ascending(c["frequency"], fb)
        c["m_score"] = score_ascending(c["monetary"], mb)
        c["rfm_cell"] = f"{c['r_score']}{c['f_score']}{c['m_score']}"
        c["segment"] = assign_segment(c["r_score"], c["f_score"])
    return out


def build_from_csv(path: str, as_of: str = "2011-12-10") -> list[dict]:
    with open(path, newline="", encoding="utf-8") as fh:
        return build_from_rows(csv.DictReader(fh), as_of=as_of)


def summarise(rfm: list[dict]) -> list[dict]:
    by: dict[str, list[dict]] = defaultdict(list)
    for c in rfm:
        by[c["segment"]].append(c)
    rows = []
    for seg, members in by.items():
        n = len(members)
        rows.append({
            "segment": seg, "customers": n,
            "avg_recency_days": round(sum(m["recency_days"] for m in members) / n, 2),
            "avg_frequency": round(sum(m["frequency"] for m in members) / n, 2),
            "avg_monetary": round(sum(m["monetary"] for m in members) / n, 2),
            "total_monetary": round(sum(m["monetary"] for m in members), 2),
        })
    return sorted(rows, key=lambda r: -r["total_monetary"])
