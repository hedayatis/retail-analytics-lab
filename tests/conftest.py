import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

PROCESSED = ROOT / "data" / "processed"


def _load(name: str):
    p = PROCESSED / name
    if not p.exists():
        pytest.skip(f"{name} not built; run `make pipeline` first")
    return pd.read_parquet(p)


@pytest.fixture(scope="session")
def sales():
    return _load("fct_sales.parquet")


@pytest.fixture(scope="session")
def rfm_table():
    return _load("rfm_customers.parquet")


@pytest.fixture(scope="session")
def warehouse_path():
    p = PROCESSED / "retail.duckdb"
    if not p.exists():
        pytest.skip("warehouse not built; run `make pipeline` first")
    return p


@pytest.fixture(scope="session")
def project_root():
    return ROOT
