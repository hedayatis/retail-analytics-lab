"""RFM scoring: the properties that must hold, and the tie trap that
motivated the scoring rule in the first place."""
import itertools

import numpy as np
import pandas as pd
import pytest

from retail_lab.analytics.rfm import (SEGMENT_RULES, assign_segment,
                                      quantile_breaks, score_ascending,
                                      score_descending)


def test_segment_ladder_is_exhaustive_over_all_25_cells():
    for r, f in itertools.product(range(1, 6), repeat=2):
        assert assign_segment(r, f) in {n for n, _ in SEGMENT_RULES}


def test_scores_are_always_within_one_to_five():
    x = pd.Series(np.random.default_rng(0).lognormal(3, 1.4, 5000))
    b = quantile_breaks(x)
    for s in (score_ascending(x, b), score_descending(x, b)):
        assert s.between(1, 5).all()


def test_ascending_and_descending_are_mirror_images():
    x = pd.Series([1, 5, 10, 50, 100, 500.0])
    b = quantile_breaks(x)
    assert (score_ascending(x, b) + score_descending(x, b) == 6).all()


def test_tied_values_always_receive_the_same_score():
    """The property NTILE cannot offer: identical customers score identically."""
    x = pd.Series([1] * 40 + [2] * 30 + [3] * 20 + [10] * 10, dtype="float64")
    s = score_ascending(x, quantile_breaks(x))
    assert pd.DataFrame({"x": x, "s": s}).groupby("x")["s"].nunique().eq(1).all()


def test_ntile_would_split_ties_and_ours_does_not():
    """Demonstrates the defect rather than asserting it in a comment.

    NTILE distributes a run of tied values across bucket boundaries by row
    order, so two customers with identical frequency land in different
    quintiles. This is the reason the project does not use NTILE/qcut.
    """
    duckdb = pytest.importorskip("duckdb")
    x = pd.Series([1] * 60 + [2] * 20 + [5] * 20, dtype="float64", name="v")
    df = x.to_frame()
    ntile = duckdb.connect().execute(
        "SELECT v, NTILE(5) OVER (ORDER BY v) AS q FROM df").fetch_df()
    ours = pd.DataFrame({"v": x, "q": score_ascending(x, quantile_breaks(x))})
    assert ntile.groupby("v")["q"].nunique().max() > 1     # NTILE splits ties
    assert ours.groupby("v")["q"].nunique().max() == 1     # ours never does


def test_breaks_match_r_type7_quantiles():
    """R's quantile(type=7) is numpy's method='linear'; the parity between
    implementations depends on this and is worth pinning."""
    x = pd.Series([1.0, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    # type-7 quantile of 0..1 over n=10 -> (n-1)*p + 1 interpolated
    assert quantile_breaks(x, (0.2, 0.5)) == pytest.approx([2.8, 5.5])


# ---------------------------------------------------------------- real data
def test_real_rfm_covers_every_identified_customer(sales, rfm_table):
    assert rfm_table.customer_id.nunique() == sales.customer_id.nunique()
    assert rfm_table.customer_id.is_unique


def test_real_monetary_reconciles_to_sales(sales, rfm_table):
    total = sales.loc[sales.customer_id.notna(), "line_revenue"].sum()
    assert rfm_table.monetary.sum() == pytest.approx(total, abs=0.05)


def test_real_frequency_matches_distinct_invoice_count(sales, rfm_table):
    expect = (sales.loc[sales.customer_id.notna()]
              .groupby("customer_id")["invoice"].nunique().sort_index())
    got = rfm_table.set_index("customer_id")["frequency"].sort_index()
    assert (expect.to_numpy() == got.to_numpy()).all()


def test_no_customer_is_unsegmented(rfm_table):
    assert rfm_table.segment.notna().all()
    assert rfm_table.rfm_cell.str.fullmatch(r"[1-5]{3}").all()
