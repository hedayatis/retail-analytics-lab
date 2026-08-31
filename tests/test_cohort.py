"""Cohort mechanics: calendar-month arithmetic and right-censoring."""
import pandas as pd
import pytest

from retail_lab.analytics.cohort import _month_ordinal, _ord_to_label, build, to_matrix


def _sales(rows):
    df = pd.DataFrame(rows, columns=["customer_id", "invoice_date", "line_revenue"])
    df["invoice_date"] = pd.to_datetime(df["invoice_date"])
    df["customer_id"] = df["customer_id"].astype("Int64")
    return df


def test_month_ordinal_is_contiguous_across_a_year_boundary():
    s = pd.to_datetime(pd.Series(["2010-12-31", "2011-01-01"]))
    o = _month_ordinal(s)
    assert o.iloc[1] - o.iloc[0] == 1


def test_month_index_uses_calendar_months_not_30_day_blocks():
    """31 Jan -> 1 Mar is 2 calendar months, but only 29 days: a day-based
    index would call it month 0 and silently mis-bucket the customer."""
    df = _sales([(1, "2010-01-31", 10.0), (1, "2010-03-01", 10.0)])
    out = build(df)
    # 29 days apart, but two calendar months: the customer must land at M+2.
    active = set(out.loc[out.active_customers > 0, "month_index"])
    assert active == {0, 2}
    # M+1 is observable and genuinely empty, so it is reported as a real zero.
    assert out.loc[out.month_index == 1, "retention_pct"].item() == 0.0


def test_index_zero_is_always_the_full_cohort():
    df = _sales([(1, "2010-01-05", 5.0), (2, "2010-01-06", 5.0),
                 (3, "2010-02-01", 5.0)])
    z = out_zero = build(df).query("month_index == 0")
    assert (z.retention_pct == 100.0).all()
    assert z.set_index("cohort_month").loc["2010-01", "cohort_size"] == 2


def test_censored_cells_are_dropped_rather_than_reported_as_zero():
    """A cohort acquired in the final month has not failed to retain."""
    df = _sales([(1, "2010-01-05", 5.0), (2, "2010-03-05", 5.0)])
    out = build(df)
    march = out.query("cohort_month == '2010-03'")
    assert list(march.month_index) == [0]           # nothing beyond is observable
    jan = out.query("cohort_month == '2010-01'")
    assert jan.month_index.max() == 2               # Jan can be read out to M+2


def test_absent_month_inside_the_window_is_a_real_zero():
    df = _sales([(1, "2010-01-05", 5.0), (1, "2010-03-05", 5.0)])
    out = build(df).set_index("month_index")
    assert out.loc[1, "retention_pct"] == 0.0       # observable, genuinely absent
    assert out.loc[2, "retention_pct"] == 100.0


def test_a_customer_counted_once_per_month_however_many_orders(sales=None):
    df = _sales([(1, "2010-01-05", 5.0), (1, "2010-01-09", 5.0),
                 (1, "2010-01-20", 5.0)])
    assert build(df).loc[0, "active_customers"] == 1


def test_ordinal_label_roundtrip():
    for label in ("2009-12", "2010-01", "2011-12"):
        y, m = map(int, label.split("-"))
        assert _ord_to_label(y * 12 + m) == label


def test_retention_never_exceeds_one_hundred_percent():
    df = _sales([(i, "2010-01-05", 5.0) for i in range(50)] +
                [(i, "2010-04-05", 5.0) for i in range(20)])
    assert build(df).retention_pct.le(100.0).all()


# ---------------------------------------------------------------- real data
def test_real_cohort_sizes_sum_to_identified_customers(sales):
    out = build(sales)
    total = out.query("month_index == 0").cohort_size.sum()
    assert total == sales.customer_id.nunique()


def test_real_matrix_is_triangular(sales):
    m = to_matrix(build(sales)).set_index("cohort_month")
    latest = m.index.max()
    assert m.loc[latest].drop("cohort_size").notna().sum() == 1   # only M+0
