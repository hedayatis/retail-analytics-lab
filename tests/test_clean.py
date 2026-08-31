"""Cleaning rules tested on hand-built fixtures where the answer is known,
plus invariants asserted against the real cleaned output."""
import pandas as pd
import pytest

from retail_lab.clean import PRODUCT_CODE, run, split_returns


def _raw(**over):
    base = dict(invoice=["489434"], stock_code=["85048"], description=["THING"],
                quantity=[12.0], invoice_date=[pd.Timestamp("2010-01-04 10:00")],
                unit_price=[6.95], customer_id=[13085.0], country=["United Kingdom"])
    base.update(over)
    return pd.DataFrame(base).astype({"invoice": "string", "stock_code": "string",
                                      "description": "string", "country": "string"})


@pytest.mark.parametrize("code,is_product", [
    ("85048", True), ("79323P", True), ("22041", True), ("DCGS0058", False),
    ("POST", False), ("BANK CHARGES", False), ("gift_0001_20", False),
    ("M", False), ("D", False), ("TEST001", False), ("B", False),
])
def test_product_code_pattern(code, is_product):
    assert bool(PRODUCT_CODE.fullmatch(code)) is is_product


def test_returns_split_uses_the_union_of_both_signals():
    """C-prefix and negative quantity disagree on thousands of rows, so
    neither signal alone is sufficient."""
    df = pd.concat([
        _raw(invoice=["C489435"], quantity=[-2.0]),   # both signals
        _raw(quantity=[-3.0]),                        # negative only
        _raw(invoice=["C489436"], quantity=[1.0]),    # C-prefix only
        _raw(),                                       # neither -> a sale
    ], ignore_index=True)
    fwd, ret = split_returns(df)
    assert len(ret) == 3 and len(fwd) == 1


def test_exact_duplicates_are_dropped_once():
    df = pd.concat([_raw(), _raw(), _raw()], ignore_index=True)
    out = run(df)
    assert len(out["sales"]) == 1
    led = out["ledger"].set_index("rule")
    assert led.loc["exact_duplicate", "rows_removed"] == 2


def test_ledger_rows_reconcile_end_to_end():
    """rows_before - rows_removed == rows_after for every rule: the ledger
    must actually account for the data, not merely describe it."""
    df = pd.concat([_raw(), _raw(invoice=["A506401"], stock_code=["B"],
                                 unit_price=[-53594.36], customer_id=[None]),
                    _raw(stock_code=["POST"]), _raw(unit_price=[0.0])],
                   ignore_index=True)
    led = run(df)["ledger"]
    assert (led.rows_before - led.rows_removed == led.rows_after).all()


def test_ledger_records_gross_value_not_unit_price():
    """The ledger must state what the rule COST, i.e. quantity x price."""
    df = pd.concat([_raw(), _raw(stock_code=["POST"], quantity=[12.0], unit_price=[18.0])],
                   ignore_index=True)
    led = run(df)["ledger"].set_index("rule")
    assert led.loc["non_product_stock_code", "gross_value_removed"] == pytest.approx(12 * 18.0)


def test_c_prefixed_positive_quantity_is_normalised_negative():
    df = _raw(invoice=["C496350"], stock_code=["22041"], quantity=[1.0], unit_price=[373.57])
    rets = run(df)["returns"]
    assert len(rets) == 1 and rets.loc[0, "quantity"] == -1


# ---------------------------------------------------------------- real data
def test_real_sales_have_no_returns_leaked_in(sales):
    assert (sales.quantity > 0).all()
    assert (sales.unit_price > 0).all()
    assert not sales.invoice.str.startswith(("C", "A")).any()


def test_real_revenue_identity_holds_to_the_penny(sales):
    diff = (sales.line_revenue - sales.quantity * sales.unit_price).abs()
    assert diff.max() < 0.005


def test_every_real_stock_code_is_a_product_code(sales):
    assert sales.stock_code.str.match(PRODUCT_CODE).all()


def test_sales_line_id_is_a_dense_surrogate_key(sales):
    assert sales.sales_line_id.is_unique
    assert sales.sales_line_id.min() == 1
    assert sales.sales_line_id.max() == len(sales)
