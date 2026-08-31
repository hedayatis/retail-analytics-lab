"""Cross-implementation parity.

The same two analyses are implemented three times -- pandas, SQL and base R --
and must agree exactly. This is the project's real integration test: it catches
definitional drift (a different recency convention, a different tie rule, day
arithmetic instead of month arithmetic) that no single-language test can see.

The R leg runs under webR (R compiled to WebAssembly) via `make parity-r`,
which writes data/processed/rfm_r.csv and cohort_r.csv. When those files are
absent the R comparisons skip rather than fail, so the suite stays runnable
without a Node toolchain.
"""
import pandas as pd
import pytest

duckdb = pytest.importorskip("duckdb")

RFM_EXACT = ["customer_id", "recency_days", "frequency",
             "r_score", "f_score", "m_score", "rfm_cell", "segment"]
COH_EXACT = ["cohort_month", "month_index", "cohort_size",
             "active_customers", "retention_pct"]


def _sql(project_root, warehouse_path, script):
    sql = (project_root / "sql" / script).read_text()
    con = duckdb.connect(str(warehouse_path), read_only=True)
    try:
        return con.execute(sql).fetch_df()
    finally:
        con.close()


def _r(project_root, name):
    p = project_root / "data" / "processed" / name
    if not p.exists():
        pytest.skip(f"{name} not built; run `make parity-r`")
    return pd.read_csv(p)


def _aligned(a, b, key):
    return (a.sort_values(key).reset_index(drop=True),
            b.sort_values(key).reset_index(drop=True))


def _assert_columns_identical(a, b, cols, label):
    assert len(a) == len(b), f"{label}: row counts differ ({len(a)} vs {len(b)})"
    for c in cols:
        x, y = a[c].to_numpy().astype(str), b[c].to_numpy().astype(str)
        n = int((x != y).sum())
        assert n == 0, f"{label}: {c} differs on {n} rows"


# ------------------------------------------------------------------ RFM
def test_rfm_python_matches_sql(project_root, warehouse_path, rfm_table):
    sq = _sql(project_root, warehouse_path, "02_rfm.sql")
    a, b = _aligned(rfm_table, sq, "customer_id")
    _assert_columns_identical(a, b, RFM_EXACT, "RFM python-vs-sql")
    assert (a.monetary - b.monetary).abs().max() < 0.005


def test_rfm_python_matches_r(project_root, rfm_table):
    r = _r(project_root, "rfm_r.csv")
    a, b = _aligned(rfm_table, r, "customer_id")
    _assert_columns_identical(a, b, RFM_EXACT, "RFM python-vs-R")
    assert (a.monetary - b.monetary).abs().max() < 0.005


def test_rfm_segment_counts_agree_across_all_three(project_root, warehouse_path, rfm_table):
    r = _r(project_root, "rfm_r.csv")
    sq = _sql(project_root, warehouse_path, "02_rfm.sql")
    # compare as plain dicts: the three engines return different integer
    # backings (numpy vs pyarrow) and the assertion is about the numbers.
    counts = [t.segment.value_counts().sort_index().to_dict() for t in (rfm_table, r, sq)]
    assert counts[0] == counts[1] == counts[2]


# --------------------------------------------------------------- cohorts
def test_cohort_python_matches_sql(project_root, warehouse_path, sales):
    from retail_lab.analytics.cohort import build
    sq = _sql(project_root, warehouse_path, "03_cohort_retention.sql")
    a, b = _aligned(build(sales), sq, ["cohort_month", "month_index"])
    _assert_columns_identical(a, b, COH_EXACT, "cohort python-vs-sql")


def test_cohort_python_matches_r(project_root, sales):
    from retail_lab.analytics.cohort import build
    r = _r(project_root, "cohort_r.csv")
    a, b = _aligned(build(sales), r, ["cohort_month", "month_index"])
    _assert_columns_identical(a, b, COH_EXACT, "cohort python-vs-R")


# ------------------------------------------------- stdlib port (browser lab)
def test_stdlib_port_matches_pandas(project_root, rfm_table):
    """The dependency-free implementation the browser lab runs must agree with
    the pandas one it is a port of -- otherwise the lab demonstrates a lie."""
    from retail_lab.analytics.rfm_stdlib import build_from_csv
    csv_path = project_root / "data" / "processed" / "sales_for_r.csv"
    if not csv_path.exists():
        pytest.skip("sales_for_r.csv not built; run `make pipeline`")
    std = pd.DataFrame(build_from_csv(str(csv_path)))
    a, b = _aligned(rfm_table, std, "customer_id")
    _assert_columns_identical(a, b, RFM_EXACT, "RFM pandas-vs-stdlib")
    assert (a.monetary - b.monetary).abs().max() < 0.005


def test_stdlib_quantile_matches_numpy_type7():
    from retail_lab.analytics.rfm_stdlib import quantile_type7
    np = pytest.importorskip("numpy")
    rng = np.random.default_rng(7)
    for n in (2, 3, 17, 500):
        xs = sorted(rng.normal(size=n).tolist())
        for p in (0.2, 0.4, 0.6, 0.8, 0.5):
            assert quantile_type7(xs, p) == pytest.approx(
                float(np.quantile(xs, p, method="linear")))
