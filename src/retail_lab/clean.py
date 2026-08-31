"""Stage 2 — turn raw invoice lines into two disciplined fact tables.

The design principle here is that **cleaning is a decision log, not a filter
chain**. Every rule states what it removes and why, and the stage emits a ledger
(rows in, rows out, revenue affected) alongside the data. An analyst who
disagrees with a rule can see its exact cost and change one declaration.

The rules were derived from profiling the real data; the counts they hit are
reported in ``docs/findings.md``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

import pandas as pd

from .config import SETTINGS
from .logging_setup import get_logger, stage

log = get_logger("clean")

# A sellable product code is five digits with an optional short letter suffix
# (e.g. 85048, 79323P, 22041). Everything else -- POST, DOT, M, BANK CHARGES,
# AMAZONFEE, gift_0001_*, ADJUST, TEST001 -- is an administrative posting.
PRODUCT_CODE = re.compile(r"^\d{5}[A-Za-z]{0,3}$")


@dataclass(frozen=True)
class Rule:
    """One removal decision, stated declaratively."""
    name: str
    mask: Callable[[pd.DataFrame], pd.Series]   # True == remove this row
    rationale: str


SALES_RULES: tuple[Rule, ...] = (
    Rule(
        "ledger_adjustment",
        lambda d: d["invoice"].str.startswith("A"),
        "A-prefixed invoices are bad-debt ledger adjustments, not trade. "
        "Six rows carrying up to -£53,594 each; summing them into revenue "
        "would move the headline by more than the effect most analyses look for.",
    ),
    Rule(
        "non_product_stock_code",
        lambda d: ~d["stock_code"].str.match(PRODUCT_CODE).fillna(False),
        "Postage, manual credits, bank charges, samples, gift vouchers and test "
        "rows share the transaction table with real products but are not sales.",
    ),
    Rule(
        "non_positive_price",
        lambda d: d["unit_price"] <= SETTINGS.params.min_unit_price,
        "Zero-price lines are stock corrections ('check', '?', 'damages'); only "
        "71 of 6,202 even carry a customer id.",
    ),
    Rule(
        "missing_description",
        lambda d: d["description"].isna(),
        "A line with no product description cannot be attributed to a product; "
        "these coincide with the manual-adjustment rows.",
    ),
)


def _ledger_row(name: str, before: int, removed: int, revenue: float, why: str) -> dict:
    return {"rule": name, "rows_before": before, "rows_removed": removed,
            "rows_after": before - removed,
            "pct_removed": round(100 * removed / before, 3) if before else 0.0,
            "gross_value_removed": round(revenue, 2), "rationale": why}


def split_returns(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Separate return/cancellation lines from forward sales.

    Two independent signals mark a return, and they disagree on 3,458 rows, so
    the union is used rather than either one alone:
      * the invoice number is C-prefixed (the donor's cancellation flag), and
      * the quantity is negative.
    """
    is_cancel = df["invoice"].str.startswith("C")
    is_negative = df["quantity"] < 0
    returns_mask = is_cancel | is_negative
    log.info("returns split: %s C-prefixed, %s negative-quantity, %s union",
             f"{int(is_cancel.sum()):,}", f"{int(is_negative.sum()):,}",
             f"{int(returns_mask.sum()):,}")
    return df.loc[~returns_mask].copy(), df.loc[returns_mask].copy()


def run(raw: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Return {'sales', 'returns', 'ledger'} from a raw transaction frame."""
    with stage(log, "clean"):
        ledger: list[dict] = []

        n0 = len(raw)
        df = raw.drop_duplicates().copy()
        dup_removed = n0 - len(df)
        dup_value = float((raw[raw.duplicated()]["quantity"]
                           * raw[raw.duplicated()]["unit_price"]).sum())
        ledger.append(_ledger_row(
            "exact_duplicate", n0, dup_removed, dup_value,
            "Byte-identical invoice lines (same invoice, product, timestamp, "
            "quantity and price) across 5,391 invoices. Treated as double-scanned "
            "records; keeping them would inflate revenue and basket size."))
        log.info("dropped %s exact duplicate rows (%.2f%%)",
                 f"{dup_removed:,}", 100 * dup_removed / n0)

        forward, returns = split_returns(df)
        ledger.append(_ledger_row(
            "routed_to_returns", len(df), len(returns),
            float((returns["quantity"] * returns["unit_price"]).sum()),
            "Cancellations and negative-quantity lines moved to fct_returns so "
            "they cannot be summed into revenue by accident."))

        for rule in SALES_RULES:
            before = len(forward)
            mask = rule.mask(forward).fillna(False).astype(bool)
            removed_value = float((forward.loc[mask, "quantity"]
                                   * forward.loc[mask, "unit_price"]).sum())
            forward = forward.loc[~mask].copy()
            ledger.append(_ledger_row(rule.name, before, int(mask.sum()),
                                      removed_value, rule.rationale))
            log.info("rule %-24s removed %8s rows", rule.name, f"{int(mask.sum()):,}")

        sales = _finalise_sales(forward)
        rets, zero_value_returns = _finalise_returns(returns)
        if zero_value_returns:
            ledger.append(_ledger_row(
                "zero_value_return", len(returns), zero_value_returns, 0.0,
                "Negative-quantity lines priced at zero: stock write-offs "
                "('damages', 'lost', 'check') rather than customer returns. "
                "Excluded from fct_returns so return *value* stays meaningful."))
        led = pd.DataFrame(ledger)
        log.info("clean complete: %s sales lines, %s return lines",
                 f"{len(sales):,}", f"{len(rets):,}")
    return {"sales": sales, "returns": rets, "ledger": led}


def _finalise_sales(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["quantity"] = out["quantity"].astype("int64")
    out["unit_price"] = out["unit_price"].astype("float64")
    out["line_revenue"] = (out["quantity"] * out["unit_price"]).round(2)
    out["invoice_month"] = out["invoice_date"].dt.strftime("%Y-%m").astype("string")
    out["customer_id"] = out["customer_id"].astype("Int64")
    out = out.sort_values(["invoice_date", "invoice", "stock_code"], kind="stable")
    out.insert(0, "sales_line_id", range(1, len(out) + 1))
    return out.reset_index(drop=True)[[
        "sales_line_id", "invoice", "stock_code", "description", "quantity",
        "unit_price", "line_revenue", "invoice_date", "invoice_month",
        "customer_id", "country"]]


def _finalise_returns(df: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    out = df.copy()
    # The single C-prefixed line with a positive quantity (C496350, a manual
    # credit) is normalised to negative so the sign convention holds table-wide.
    flip = (out["invoice"].str.startswith("C")) & (out["quantity"] > 0)
    if int(flip.sum()):
        log.warning("normalising %d C-prefixed line(s) with positive quantity",
                    int(flip.sum()))
        out.loc[flip, "quantity"] = -out.loc[flip, "quantity"]
    out = out.loc[out["unit_price"] >= 0].copy()
    out["quantity"] = out["quantity"].astype("int64")
    out["line_value"] = (out["quantity"] * out["unit_price"]).round(2)
    before = len(out)
    out = out.loc[out["line_value"] < 0].copy()
    zero_value = before - len(out)
    if zero_value:
        log.info("excluded %s zero-value return lines (stock write-offs)",
                 f"{zero_value:,}")
    out["is_cancellation"] = out["invoice"].str.startswith("C").astype(bool)
    out["customer_id"] = out["customer_id"].astype("Int64")
    cols = ["invoice", "stock_code", "quantity", "unit_price", "line_value",
            "invoice_date", "customer_id", "country", "is_cancellation"]
    return out.reset_index(drop=True)[cols], zero_value
