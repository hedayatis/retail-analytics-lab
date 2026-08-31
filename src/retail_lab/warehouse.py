"""Stage 3 — materialise the star schema in DuckDB.

DuckDB is used rather than SQLite because the analytical SQL leans on window
functions, ``QUALIFY``, ``MODE``/``MEDIAN`` and ``quantile_cont`` — and because
an embedded columnar engine is the honest choice for a 1M-row analytical
workload that has to run from a laptop with no server.

The build is **idempotent**: it is safe to re-run, and it rebuilds from the
staged frames rather than mutating tables in place.
"""
from __future__ import annotations

from pathlib import Path

import duckdb
import pandas as pd

from .config import SETTINGS
from .logging_setup import get_logger, stage

log = get_logger("warehouse")


def build(sales: pd.DataFrame, returns: pd.DataFrame,
          db_path: Path | None = None) -> Path:
    paths = SETTINGS.paths.ensure()
    db_path = db_path or paths.warehouse
    script = (paths.sql / "01_star_schema.sql").read_text(encoding="utf-8")

    with stage(log, "warehouse"):
        if db_path.exists():
            db_path.unlink()                      # rebuild, never mutate in place
        con = duckdb.connect(str(db_path))
        try:
            con.register("stg_sales", sales)
            con.register("stg_returns", returns)
            con.execute(script)
            for tbl in ("fct_sales", "fct_returns", "dim_customer",
                        "dim_product", "dim_date"):
                n = con.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
                log.info("built %-13s %10s rows", tbl, f"{n:,}")
            _assert_integrity(con)
        finally:
            con.close()
    return db_path


def _assert_integrity(con: duckdb.DuckDBPyConnection) -> None:
    """Referential and arithmetic checks that must hold after every build."""
    checks = {
        "customer fk: fct_sales -> dim_customer": """
            SELECT COUNT(*) FROM fct_sales f
            LEFT JOIN dim_customer d USING (customer_id)
            WHERE f.customer_id IS NOT NULL AND d.customer_id IS NULL""",
        "product fk: fct_sales -> dim_product": """
            SELECT COUNT(*) FROM fct_sales f
            LEFT JOIN dim_product p USING (stock_code)
            WHERE p.stock_code IS NULL""",
        "date fk: fct_sales -> dim_date": """
            SELECT COUNT(*) FROM fct_sales f
            LEFT JOIN dim_date d ON d.date_day = f.invoice_day
            WHERE d.date_day IS NULL""",
        "dim_customer revenue reconciles to fct_sales": """
            SELECT COUNT(*) FROM (
              SELECT d.customer_id
              FROM dim_customer d
              JOIN (SELECT customer_id, SUM(line_revenue) r FROM fct_sales
                    WHERE customer_id IS NOT NULL GROUP BY 1) f
                USING (customer_id)
              WHERE ABS(d.lifetime_revenue - f.r) > 0.01)""",
    }
    for name, sql in checks.items():
        n = con.execute(sql).fetchone()[0]
        if n:
            raise AssertionError(f"warehouse integrity check failed — {name}: {n:,} rows")
        log.info("integrity ok  : %s", name)


def query(sql: str, db_path: Path | None = None) -> pd.DataFrame:
    """Run read-only SQL against the warehouse and return a frame."""
    db_path = db_path or SETTINGS.paths.warehouse
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        return con.execute(sql).fetch_df()
    finally:
        con.close()
