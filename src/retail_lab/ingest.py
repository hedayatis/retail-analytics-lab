"""Stage 1 — ingest the donor's .rda into a typed, checksummed parquet.

Two things make this an ingest rather than a `read_csv`:

* **Provenance.** The source file's SHA-256 is verified against the checksum
  committed alongside it, and recorded in the run manifest. If the upstream file
  is ever silently swapped, the run fails loudly instead of quietly analysing
  different data.
* **A contract.** The frame is validated against ``RAW_TRANSACTIONS`` before any
  downstream stage is allowed to touch it.
"""
from __future__ import annotations

import hashlib
import json
import platform
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .config import SETTINGS
from .contracts import ValidationReport, validate
from .logging_setup import RUN_ID, get_logger, stage
from .schemas import RAW_TRANSACTIONS

log = get_logger("ingest")

# The donor's column names -> our snake_case convention. Declared once, here,
# so that renaming never happens implicitly in the middle of a transform.
COLUMN_MAP = {
    "Invoice": "invoice",
    "StockCode": "stock_code",
    "Description": "description",
    "Quantity": "quantity",
    "InvoiceDate": "invoice_date",
    "Price": "unit_price",
    "CustomerID": "customer_id",
    "Country": "country",
}


def sha256_of(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while block := fh.read(chunk):
            h.update(block)
    return h.hexdigest()


def verify_checksum(path: Path) -> str:
    """Verify the source against its committed .sha256 sidecar, if present."""
    digest = sha256_of(path)
    sidecar = path.with_suffix(path.suffix + ".sha256")
    if sidecar.exists():
        expected = sidecar.read_text().split()[0].strip()
        if expected != digest:
            raise ValueError(
                f"checksum mismatch for {path.name}\n"
                f"  expected {expected}\n  observed {digest}\n"
                "The source file changed. Refusing to ingest silently."
            )
        log.info("checksum verified: %s", digest[:16] + "…")
    else:
        log.warning("no .sha256 sidecar for %s; recording observed digest", path.name)
    return digest


@dataclass
class IngestResult:
    frame: pd.DataFrame
    report: ValidationReport
    manifest: dict


def read_source(path: Path | None = None) -> pd.DataFrame:
    """Read the R .rda into a pandas frame with our column names and dtypes."""
    import pyreadr                                   # imported late: heavy, optional

    path = path or SETTINGS.paths.source_rda
    objects = pyreadr.read_r(str(path))
    if not objects:
        raise ValueError(f"{path} contained no R objects")
    key = next(iter(objects))
    df = objects[key]
    log.info("read R object %r: %s rows x %s cols", key, f"{len(df):,}", df.shape[1])

    unknown = set(df.columns) - set(COLUMN_MAP)
    if unknown:
        raise ValueError(f"source has unmapped columns: {sorted(unknown)}")
    df = df.rename(columns=COLUMN_MAP)

    df["invoice"] = df["invoice"].astype("string").str.strip()
    df["stock_code"] = df["stock_code"].astype("string").str.strip()
    df["description"] = df["description"].astype("string").str.strip()
    df["country"] = df["country"].astype("string").str.strip()
    df["invoice_date"] = pd.to_datetime(df["invoice_date"])
    return df[list(COLUMN_MAP.values())]


def run(path: Path | None = None, write: bool = True) -> IngestResult:
    paths = SETTINGS.paths.ensure()
    src = path or paths.source_rda
    with stage(log, "ingest"):
        digest = verify_checksum(src)
        df = read_source(src)
        report = validate(df, RAW_TRANSACTIONS)
        for v in report.violations:
            log.warning("contract %s: [%s] %s", report.contract, v.rule, v.detail)
        report.raise_for_status()

        manifest = {
            "run_id": RUN_ID,
            "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source_file": src.name,
            "source_sha256": digest,
            "rows": int(len(df)),
            "columns": list(df.columns),
            "date_min": str(df["invoice_date"].min()),
            "date_max": str(df["invoice_date"].max()),
            "contract_ok": report.ok,
            "n_warnings": len(report.warnings),
            "python": platform.python_version(),
            "pandas": pd.__version__,
        }
        if write:
            out = paths.processed / "raw_transactions.parquet"
            df.to_parquet(out, index=False)
            (paths.processed / "ingest_manifest.json").write_text(
                json.dumps(manifest, indent=2), encoding="utf-8")
            log.info("wrote %s (%.1f MB)", out.name, out.stat().st_size / 1e6)
    return IngestResult(df, report, manifest)


if __name__ == "__main__":                            # pragma: no cover
    from .logging_setup import configure
    configure(SETTINGS.log_level)
    res = run()
    print(res.report.to_markdown())
