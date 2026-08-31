"""Contracts for every stage boundary in the pipeline.

These are written against the *observed* Online Retail II data, not against an
idealised version of it. Where the source is genuinely dirty the contract says
WARN and the cleaning stage is responsible for the fix; where a value would
silently corrupt an aggregate the contract says ERROR and the run stops.
"""
from __future__ import annotations

import pandas as pd

from .contracts import Column, Contract, Severity, TableCheck

# --------------------------------------------------------------------------- #
# stage 1 — raw, exactly as the donor published it
# --------------------------------------------------------------------------- #
def _dup_rows(df: pd.DataFrame) -> int:
    return int(df.duplicated().sum())


def _out_of_window(df: pd.DataFrame) -> int:
    lo, hi = pd.Timestamp("2009-12-01"), pd.Timestamp("2011-12-10")
    d = df["invoice_date"]
    return int(((d < lo) | (d > hi)).sum())


RAW_TRANSACTIONS = Contract(
    name="raw_transactions",
    description=(
        "Online Retail II as distributed: one row per invoice line, including "
        "cancellations, ledger adjustments and non-product postings."
    ),
    min_rows=1_000_000,
    columns=(
        Column("invoice", "string", description="6 digits, optionally A- or C-prefixed",
               regex=r"^[AC]?\d{6}$"),
        Column("stock_code", "string", description="5 digits + optional suffix, or an admin code"),
        Column("description", "string", nullable=True, description="free text, unreliable"),
        Column("quantity", "numeric", description="negative on returns"),
        Column("invoice_date", "datetime"),
        Column("unit_price", "numeric", description="sterling; negative on bad-debt adjustments"),
        Column("customer_id", "numeric", nullable=True, description="absent for guest checkout"),
        Column("country", "string"),
    ),
    checks=(
        TableCheck("exact_duplicate_rows", _dup_rows, Severity.WARN,
                   "identical invoice/line/timestamp rows — resolved in the cleaning stage"),
        TableCheck("date_outside_published_window", _out_of_window, Severity.ERROR,
                   "transaction dated outside 2009-12-01 .. 2011-12-09"),
    ),
)

# --------------------------------------------------------------------------- #
# stage 2 — cleaned sales lines (the revenue-bearing fact table)
# --------------------------------------------------------------------------- #
def _revenue_mismatch(df: pd.DataFrame) -> int:
    """line_revenue must equal quantity * unit_price to the penny."""
    diff = (df["line_revenue"] - df["quantity"] * df["unit_price"]).abs()
    return int((diff > 0.005).sum())


FCT_SALES = Contract(
    name="fct_sales",
    description="One row per sold invoice line. Cancellations, returns, "
                "administrative postings and zero-price rows are excluded.",
    min_rows=800_000,
    primary_key=("sales_line_id",),
    columns=(
        Column("sales_line_id", "int", unique=True),
        Column("invoice", "string", regex=r"^\d{6}$"),
        Column("stock_code", "string"),
        Column("description", "string", nullable=True),
        Column("quantity", "int", min_value=1),
        Column("unit_price", "float", min_value=0.001),
        Column("line_revenue", "float", min_value=0.001),
        Column("invoice_date", "datetime"),
        Column("invoice_month", "string", regex=r"^\d{4}-\d{2}$"),
        Column("customer_id", "int", nullable=True),
        Column("country", "string"),
    ),
    checks=(
        TableCheck("revenue_identity", _revenue_mismatch, Severity.ERROR,
                   "line_revenue != quantity * unit_price"),
    ),
)

FCT_RETURNS = Contract(
    name="fct_returns",
    description="Cancellation and return lines (negative quantity), kept "
                "separately so they can never be summed into revenue by accident.",
    min_rows=1,
    columns=(
        Column("invoice", "string"),
        Column("stock_code", "string"),
        Column("quantity", "int", max_value=-1),
        Column("unit_price", "float", min_value=0.0),
        Column("line_value", "float", max_value=-0.001),
        Column("invoice_date", "datetime"),
        Column("customer_id", "int", nullable=True),
        Column("country", "string"),
        Column("is_cancellation", "bool"),
    ),
)

# --------------------------------------------------------------------------- #
# stage 3 — analytics outputs
# --------------------------------------------------------------------------- #
_SEGMENTS = ("Champions", "Loyal customers", "Potential loyalists", "New customers",
             "Promising", "Need attention", "At risk", "Cannot lose them",
             "Hibernating", "Lost")

RFM_CUSTOMERS = Contract(
    name="rfm_customers",
    description="One row per identified customer with R/F/M values, quintile "
                "scores and an assigned segment.",
    primary_key=("customer_id",),
    columns=(
        Column("customer_id", "int", unique=True),
        Column("recency_days", "int", min_value=0),
        Column("frequency", "int", min_value=1),
        Column("monetary", "float", min_value=0.001),
        Column("r_score", "int", min_value=1, max_value=5),
        Column("f_score", "int", min_value=1, max_value=5),
        Column("m_score", "int", min_value=1, max_value=5),
        Column("rfm_cell", "string", regex=r"^[1-5]{3}$"),
        Column("segment", "string", allowed=_SEGMENTS),
    ),
)

COHORT_RETENTION = Contract(
    name="cohort_retention",
    description="Acquisition-cohort retention: share of a cohort active in each "
                "subsequent month index.",
    primary_key=("cohort_month", "month_index"),
    columns=(
        Column("cohort_month", "string", regex=r"^\d{4}-\d{2}$"),
        Column("month_index", "int", min_value=0, max_value=24),
        Column("cohort_size", "int", min_value=1),
        Column("active_customers", "int", min_value=0),
        Column("retention_pct", "float", min_value=0.0, max_value=100.0),
    ),
)

ALL_CONTRACTS = (RAW_TRANSACTIONS, FCT_SALES, FCT_RETURNS,
                 RFM_CUSTOMERS, COHORT_RETENTION)
