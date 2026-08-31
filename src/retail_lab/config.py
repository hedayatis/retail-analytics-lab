"""Central configuration for the retail analytics lab.

Every path and tunable in the pipeline resolves through here, so a run can be
relocated (CI, container, another machine) by changing one environment variable
instead of editing modules.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

_ENV_ROOT = "RETAIL_LAB_ROOT"


def _project_root() -> Path:
    if (env := os.environ.get(_ENV_ROOT)):
        return Path(env).expanduser().resolve()
    # src/retail_lab/config.py -> src/retail_lab -> src -> <root>
    return Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Paths:
    root: Path = field(default_factory=_project_root)

    @property
    def data(self) -> Path: return self.root / "data"
    @property
    def raw(self) -> Path: return self.data / "raw"
    @property
    def processed(self) -> Path: return self.data / "processed"
    @property
    def reports(self) -> Path: return self.data / "reports"
    @property
    def sql(self) -> Path: return self.root / "sql"
    @property
    def warehouse(self) -> Path: return self.processed / "retail.duckdb"
    @property
    def source_rda(self) -> Path: return self.raw / "onlineretail2.rda"

    def ensure(self) -> "Paths":
        for p in (self.processed, self.reports):
            p.mkdir(parents=True, exist_ok=True)
        return self


@dataclass(frozen=True)
class Params:
    """Analysis parameters. Defaults are stated, not implied.

    ``as_of`` pins the reference date used by recency. The dataset ends
    2011-12-09; using ``today`` would make every customer look dormant, so the
    reference date is the day after the last observed transaction. Pinning it
    also makes RFM output reproducible forever.
    """
    as_of: date = date(2011, 12, 10)
    rfm_bins: int = 5
    # A basket line is a return if quantity < 0; the invoice is a cancellation
    # if its number starts with this prefix (documented by the data donor).
    cancellation_prefix: str = "C"
    # Stock codes that are administrative postings, not sellable products.
    admin_stock_codes: tuple[str, ...] = (
        "POST", "D", "DOT", "M", "S", "AMAZONFEE", "m", "DCGSSBOY", "DCGSSGIRL",
        "PADS", "B", "CRUK", "C2", "BANK CHARGES", "TEST001", "TEST002", "ADJUST",
        "ADJUST2", "gift_0001_10", "gift_0001_20", "gift_0001_30", "gift_0001_40",
        "gift_0001_50", "SP1002", "8888",
    )
    min_unit_price: float = 0.0     # strictly greater than, for revenue lines
    cohort_horizon_months: int = 12


@dataclass(frozen=True)
class Settings:
    paths: Paths = field(default_factory=Paths)
    params: Params = field(default_factory=Params)
    log_level: str = os.environ.get("RETAIL_LAB_LOG", "INFO")


SETTINGS = Settings()
