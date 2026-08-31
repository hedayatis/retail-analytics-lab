"""Build the data bundle the browser lab loads.

The lab runs the *real* R and Python source on a **stratified sample** rather
than the full 1M lines: webR and Pyodide are WebAssembly runtimes and a 22 MB
CSV would make the page take a minute to become useful. The sample takes every
transaction of a random subset of customers, stratified by acquisition cohort,
so RFM and cohort retention stay internally coherent -- a customer is either
wholly in or wholly out, never half-sampled.

Full-population results, computed by the pipeline and verified three ways, are
shipped alongside as JSON so the page can show what the real answer is next to
what the visitor just computed.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .analytics import cohort, rfm
from .config import SETTINGS
from .logging_setup import get_logger, stage

log = get_logger("lab_export")

N_CUSTOMERS = 25
SEED = 20111209


def export(n_customers: int = N_CUSTOMERS, seed: int = SEED) -> dict:
    paths = SETTINGS.paths
    lab_data = paths.root / "lab" / "data"
    lab_data.mkdir(parents=True, exist_ok=True)

    with stage(log, "lab_export"):
        sales = pd.read_parquet(paths.processed / "fct_sales.parquet")
        rfm_full = pd.read_parquet(paths.processed / "rfm_customers.parquet")
        coh_full = pd.read_parquet(paths.processed / "cohort_retention.parquet")
        ledger = pd.read_csv(paths.reports / "cleaning_ledger.csv")

        # ---- stratified customer sample -------------------------------- #
        attributed = sales.loc[sales["customer_id"].notna()].copy()
        first = (attributed.groupby("customer_id")["invoice_date"].min()
                 .dt.strftime("%Y-%m").rename("cohort").reset_index())
        rng = np.random.default_rng(seed)
        picks: list = []
        for _, grp in first.groupby("cohort"):
            share = max(1, round(n_customers * len(grp) / len(first)))
            take = min(share, len(grp))
            picks += list(rng.choice(grp["customer_id"].to_numpy(), take, replace=False))
        picks_arr = np.array(sorted(picks))
        sample = attributed.loc[attributed["customer_id"].isin(picks_arr)].copy()
        sample["invoice_day"] = sample["invoice_date"].dt.strftime("%Y-%m-%d")
        sample = sample[["customer_id", "invoice", "invoice_day", "line_revenue"]]
        sample.to_csv(lab_data / "sales_sample.csv", index=False)
        log.info("sample: %s customers, %s lines (%.1f%% of attributed rows)",
                 f"{len(picks_arr):,}", f"{len(sample):,}",
                 100 * len(sample) / len(attributed))

        # ---- full-population results for the charts --------------------- #
        monthly = (sales.groupby("invoice_month")
                   .agg(revenue=("line_revenue", "sum"),
                        orders=("invoice", "nunique"),
                        customers=("customer_id", "nunique"))
                   .reset_index())
        monthly["revenue"] = monthly["revenue"].round(2)

        by_country = (sales.groupby("country")["line_revenue"].sum()
                      .sort_values(ascending=False).head(10).round(2).reset_index())

        segments = rfm.summarise(rfm_full)
        matrix = cohort.to_matrix(coh_full)

        bundle = {
            "meta": {
                "source": "UCI Online Retail II (Chen, D.) via the R package "
                          "onlineretail2, redistributed with the donor's "
                          "permission for non-commercial use",
                "rows_raw": 1_067_371,
                "rows_sales": int(len(sales)),
                "rows_returns": int(pd.read_parquet(
                    paths.processed / "fct_returns.parquet").shape[0]),
                "customers": int(rfm_full["customer_id"].nunique()),
                "revenue_gbp": round(float(sales["line_revenue"].sum()), 2),
                "date_min": str(sales["invoice_date"].min().date()),
                "date_max": str(sales["invoice_date"].max().date()),
                "as_of": str(SETTINGS.params.as_of),
                "sample_customers": int(len(picks_arr)),
                "sample_rows": int(len(sample)),
            },
            "ledger": ledger.to_dict("records"),
            "monthly": monthly.to_dict("records"),
            "by_country": by_country.to_dict("records"),
            "segments": segments.to_dict("records"),
            # NaN is not valid JSON. Censored cohort cells must serialise as
            # null so the page can distinguish "not observable" from zero.
            "cohort_matrix": [
                {k: (None if (isinstance(v, float) and pd.isna(v)) else v)
                 for k, v in rec.items()}
                for rec in matrix.to_dict("records")],
            "rfm_head": rfm_full.head(8).to_dict("records"),
        }
        # allow_nan=False makes a NaN leak a loud failure here rather than a
        # silent JSON syntax error in the browser.
        (lab_data / "results.json").write_text(
            json.dumps(bundle, indent=1, default=str, allow_nan=False),
            encoding="utf-8")

        # ---- ship the actual source the lab executes -------------------- #
        root = paths.root
        src = {
            "rfm.R": (root / "R" / "rfm.R").read_text(),
            "cohort.R": (root / "R" / "cohort.R").read_text(),
            "rfm.py": (root / "src/retail_lab/analytics/rfm.py").read_text(),
            "rfm_stdlib.py": (root / "src/retail_lab/analytics/rfm_stdlib.py").read_text(),
            "schemas.py": (root / "src/retail_lab/schemas.py").read_text(),
            "cohort.py": (root / "src/retail_lab/analytics/cohort.py").read_text(),
            "contracts.py": (root / "src/retail_lab/contracts.py").read_text(),
            "clean.py": (root / "src/retail_lab/clean.py").read_text(),
            "02_rfm.sql": (root / "sql/02_rfm.sql").read_text(),
            "03_cohort_retention.sql": (root / "sql/03_cohort_retention.sql").read_text(),
            "01_star_schema.sql": (root / "sql/01_star_schema.sql").read_text(),
        }
        (lab_data / "sources.json").write_text(json.dumps(src), encoding="utf-8")
        log.info("bundle written to lab/data/ (%d source files embedded)", len(src))
    return bundle


if __name__ == "__main__":                                   # pragma: no cover
    from .logging_setup import configure
    configure("INFO")
    export()
