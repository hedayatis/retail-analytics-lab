"""Unit tests for the contract engine itself.

The engine is the thing every other stage trusts, so it is tested against
hand-built frames where the right answer is known by construction.
"""
import pandas as pd
import pytest

from retail_lab.contracts import (Column, Contract, ContractError, Severity,
                                  TableCheck, validate)


def test_clean_frame_passes():
    c = Contract("t", (Column("a", "int"), Column("b", "string")))
    rep = validate(pd.DataFrame({"a": [1, 2], "b": ["x", "y"]}), c)
    assert rep.ok and not rep.violations


def test_reports_every_violation_not_just_the_first():
    """A report that stops at the first problem costs one debug cycle each."""
    c = Contract("t", (Column("a", "int", min_value=0),
                       Column("b", "string", allowed=("x",))),
                 primary_key=("a",))
    df = pd.DataFrame({"a": [-1, -1], "b": ["z", "z"]})
    rules = {v.rule for v in validate(df, c).violations}
    assert {"min_value", "allowed_values", "primary_key"} <= rules


def test_null_in_non_nullable_column_is_an_error():
    c = Contract("t", (Column("a", "float"),))
    rep = validate(pd.DataFrame({"a": [1.0, None]}), c)
    assert not rep.ok and rep.errors[0].rule == "not_null"
    assert rep.errors[0].n_rows == 1


def test_nullable_column_tolerates_nulls():
    c = Contract("t", (Column("a", "float", nullable=True),))
    assert validate(pd.DataFrame({"a": [1.0, None]}), c).ok


def test_dtype_family_mismatch_is_caught():
    c = Contract("t", (Column("a", "int"),))
    assert any(v.rule == "dtype" for v in validate(pd.DataFrame({"a": ["1"]}), c).violations)


def test_undeclared_column_warns_but_does_not_fail():
    c = Contract("t", (Column("a", "int"),))
    rep = validate(pd.DataFrame({"a": [1], "surprise": [2]}), c)
    assert rep.ok and rep.warnings[0].rule == "unexpected_columns"


def test_extra_columns_can_be_allowed():
    c = Contract("t", (Column("a", "int"),), allow_extra_columns=True)
    assert not validate(pd.DataFrame({"a": [1], "b": [2]}), c).violations


def test_regex_is_fullmatch_not_search():
    c = Contract("t", (Column("a", "string", regex=r"\d{3}"),))
    assert not validate(pd.DataFrame({"a": ["1234"]}), c).ok


def test_table_check_severity_is_respected():
    c = Contract("t", (Column("a", "int"),),
                 checks=(TableCheck("evens", lambda d: int((d.a % 2 == 0).sum()),
                                    Severity.WARN, "even values"),))
    rep = validate(pd.DataFrame({"a": [2, 4]}), c)
    assert rep.ok and len(rep.warnings) == 1


def test_a_check_that_raises_is_itself_a_violation():
    c = Contract("t", (Column("a", "int"),),
                 checks=(TableCheck("boom", lambda d: 1 / 0),))
    rep = validate(pd.DataFrame({"a": [1]}), c)
    assert not rep.ok and "ZeroDivisionError" in rep.errors[0].detail


def test_raise_for_status_names_the_contract():
    c = Contract("payments", (Column("a", "int", min_value=0),))
    with pytest.raises(ContractError, match="payments"):
        validate(pd.DataFrame({"a": [-1]}), c).raise_for_status()


def test_unknown_dtype_family_fails_fast_at_definition_time():
    with pytest.raises(ValueError, match="unknown dtype"):
        Column("a", "sasquatch")


def test_report_renders_markdown_and_json():
    c = Contract("t", (Column("a", "int", min_value=5),))
    rep = validate(pd.DataFrame({"a": [1]}), c)
    assert "min_value" in rep.to_markdown() and '"ok": false' in rep.to_json()
