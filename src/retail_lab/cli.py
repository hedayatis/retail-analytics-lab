"""Command-line entry point.

    python -m retail_lab.cli pipeline      # ingest -> clean -> warehouse -> analytics
    python -m retail_lab.cli ingest
    python -m retail_lab.cli analytics --as-of 2011-12-10
    python -m retail_lab.cli export-lab    # build the browser lab's data bundle

Every subcommand is idempotent and writes a run manifest, so a rerun either
reproduces the previous outputs byte-for-byte or explains why it cannot.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timezone

import pandas as pd

from . import clean, ingest, warehouse
from .analytics import cohort, rfm
from .config import SETTINGS
from .contracts import validate, write_report
from .logging_setup import RUN_ID, configure, get_logger
from .schemas import COHORT_RETENTION, FCT_RETURNS, FCT_SALES, RFM_CUSTOMERS

log = get_logger("cli")


def _write(df: pd.DataFrame, name: str) -> None:
    path = SETTINGS.paths.processed / name
    df.to_parquet(path, index=False)
    log.info("wrote %-28s %9s rows", name, f"{len(df):,}")


def cmd_ingest(_args) -> pd.DataFrame:
    return ingest.run().frame


def cmd_clean(_args) -> dict:
    raw = pd.read_parquet(SETTINGS.paths.processed / "raw_transactions.parquet")
    out = clean.run(raw)
    _write(out["sales"], "fct_sales.parquet")
    _write(out["returns"], "fct_returns.parquet")
    out["ledger"].to_csv(SETTINGS.paths.reports / "cleaning_ledger.csv", index=False)
    return out


def cmd_warehouse(_args):
    p = SETTINGS.paths.processed
    warehouse.build(pd.read_parquet(p / "fct_sales.parquet"),
                    pd.read_parquet(p / "fct_returns.parquet"))


def cmd_analytics(args) -> dict:
    as_of = date.fromisoformat(args.as_of) if getattr(args, "as_of", None) else None
    sales = pd.read_parquet(SETTINGS.paths.processed / "fct_sales.parquet")
    rfm_tbl = rfm.build(sales, as_of=as_of)
    coh = cohort.build(sales, max_index=SETTINGS.params.cohort_horizon_months)
    _write(rfm_tbl, "rfm_customers.parquet")
    _write(coh, "cohort_retention.parquet")
    rfm.summarise(rfm_tbl).to_csv(
        SETTINGS.paths.reports / "rfm_segments.csv", index=False)
    # CSV twins for the Node/webR parity harness, which has no pandas
    rfm_tbl.to_csv(SETTINGS.paths.processed / "rfm_python.csv", index=False)
    coh.to_csv(SETTINGS.paths.processed / "cohort_python.csv", index=False)
    sales_r = sales.loc[sales["customer_id"].notna(),
                        ["customer_id", "invoice", "invoice_date", "line_revenue"]].copy()
    sales_r["invoice_day"] = sales_r["invoice_date"].dt.strftime("%Y-%m-%d")
    sales_r[["customer_id", "invoice", "invoice_day", "line_revenue"]].to_csv(
        SETTINGS.paths.processed / "sales_for_r.csv", index=False)
    cohort.to_matrix(coh).to_csv(
        SETTINGS.paths.reports / "cohort_matrix.csv", index=False)
    return {"rfm": rfm_tbl, "cohort": coh, "sales": sales}


def cmd_pipeline(args) -> int:
    started = datetime.now(timezone.utc)
    raw = cmd_ingest(args)
    cleaned = cmd_clean(args)
    cmd_warehouse(args)
    an = cmd_analytics(args)

    reports = [
        validate(cleaned["sales"], FCT_SALES),
        validate(cleaned["returns"], FCT_RETURNS),
        validate(an["rfm"], RFM_CUSTOMERS),
        validate(an["cohort"], COHORT_RETENTION),
    ]
    write_report(reports, SETTINGS.paths.reports / "data_quality.md")
    failed = [r.contract for r in reports if not r.ok]

    manifest = {
        "run_id": RUN_ID,
        "started_utc": started.isoformat(timespec="seconds"),
        "finished_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "as_of": str(getattr(args, "as_of", None) or SETTINGS.params.as_of),
        "rows": {"raw": len(raw), "sales": len(cleaned["sales"]),
                 "returns": len(cleaned["returns"]),
                 "customers": len(an["rfm"]), "cohort_cells": len(an["cohort"])},
        "revenue_gbp": round(float(cleaned["sales"].line_revenue.sum()), 2),
        "returns_gbp": round(float(cleaned["returns"].line_value.sum()), 2),
        "contracts_failed": failed,
    }
    (SETTINGS.paths.reports / "run_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8")

    if failed:
        log.error("pipeline finished with failing contracts: %s", ", ".join(failed))
        return 1
    log.info("pipeline OK — £%s revenue across %s sales lines",
             f"{manifest['revenue_gbp']:,.2f}", f"{manifest['rows']['sales']:,}")
    return 0


def cmd_export_lab(_args) -> int:
    from .lab_export import export
    export()
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="retail_lab", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--log", default=SETTINGS.log_level, help="log level")
    sub = p.add_subparsers(dest="command", required=True)
    for name, fn, helptext in (
        ("ingest", cmd_ingest, "read and validate the donor .rda"),
        ("clean", cmd_clean, "apply the cleaning rule ladder"),
        ("warehouse", cmd_warehouse, "build the DuckDB star schema"),
        ("analytics", cmd_analytics, "compute RFM and cohort retention"),
        ("pipeline", cmd_pipeline, "run every stage end to end"),
        ("export-lab", cmd_export_lab, "build the browser lab data bundle"),
    ):
        sp = sub.add_parser(name, help=helptext)
        sp.set_defaults(func=fn)
        if name in ("analytics", "pipeline"):
            sp.add_argument("--as-of", help="reference date, YYYY-MM-DD")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    configure(args.log)
    result = args.func(args)
    return result if isinstance(result, int) else 0


if __name__ == "__main__":                                    # pragma: no cover
    sys.exit(main())
