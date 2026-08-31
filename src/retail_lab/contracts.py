"""A small declarative data-contract engine.

Why this exists
---------------
Most analysis code discovers bad data by crashing three steps later, in a
groupby, with a message that names neither the column nor the row. A contract
moves that discovery to the boundary between stages and makes it *describable*:
each stage declares the shape it promises to emit, the engine checks the frame
against that promise, and the result is a report you can print, diff between
runs, or fail a build on.

The engine is deliberately dependency-free (pandas only). It is ~200 lines
because the point is to show the design, not to reimplement Great Expectations.

Usage
-----
>>> report = validate(df, RAW_TRANSACTIONS)
>>> report.raise_for_status()          # ERROR-severity violations abort
>>> print(report.to_markdown())
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Callable, Sequence

import pandas as pd
from pandas.api import types as pdt


class Severity(str, Enum):
    ERROR = "ERROR"     # violates the contract; the pipeline must stop
    WARN = "WARN"       # tolerated, but recorded and reported


# --------------------------------------------------------------------------- #
# dtype families
# --------------------------------------------------------------------------- #
_DTYPE_PREDICATES: dict[str, Callable[[pd.Series], bool]] = {
    "int": pdt.is_integer_dtype,
    "float": pdt.is_float_dtype,
    "numeric": pdt.is_numeric_dtype,
    "string": lambda s: pdt.is_string_dtype(s) or pdt.is_object_dtype(s),
    "datetime": pdt.is_datetime64_any_dtype,
    "bool": pdt.is_bool_dtype,
}


@dataclass(frozen=True)
class Column:
    """One column's promise."""
    name: str
    dtype: str                              # key of _DTYPE_PREDICATES
    nullable: bool = False
    unique: bool = False
    allowed: tuple[str, ...] | None = None  # closed value set
    min_value: float | None = None
    max_value: float | None = None
    regex: str | None = None
    description: str = ""

    def __post_init__(self) -> None:
        if self.dtype not in _DTYPE_PREDICATES:
            raise ValueError(
                f"{self.name}: unknown dtype family {self.dtype!r}; "
                f"expected one of {sorted(_DTYPE_PREDICATES)}"
            )


@dataclass(frozen=True)
class TableCheck:
    """A table-level predicate: returns the count of offending rows (0 == pass)."""
    name: str
    fn: Callable[[pd.DataFrame], int]
    severity: Severity = Severity.ERROR
    description: str = ""


@dataclass(frozen=True)
class Contract:
    name: str
    columns: tuple[Column, ...]
    primary_key: tuple[str, ...] = ()
    checks: tuple[TableCheck, ...] = ()
    min_rows: int = 1
    allow_extra_columns: bool = False
    description: str = ""

    @property
    def column_names(self) -> tuple[str, ...]:
        return tuple(c.name for c in self.columns)


@dataclass(frozen=True)
class Violation:
    rule: str
    severity: Severity
    column: str | None
    n_rows: int
    detail: str

    def as_dict(self) -> dict:
        d = asdict(self)
        d["severity"] = self.severity.value
        return d


class ContractError(AssertionError):
    """Raised when a frame breaks an ERROR-severity clause of its contract."""


@dataclass
class ValidationReport:
    contract: str
    n_rows: int
    violations: list[Violation] = field(default_factory=list)

    @property
    def errors(self) -> list[Violation]:
        return [v for v in self.violations if v.severity is Severity.ERROR]

    @property
    def warnings(self) -> list[Violation]:
        return [v for v in self.violations if v.severity is Severity.WARN]

    @property
    def ok(self) -> bool:
        return not self.errors

    def raise_for_status(self) -> "ValidationReport":
        if self.errors:
            lines = "\n".join(f"  - [{v.rule}] {v.detail}" for v in self.errors)
            raise ContractError(
                f"contract {self.contract!r} failed with "
                f"{len(self.errors)} error(s):\n{lines}"
            )
        return self

    def to_markdown(self) -> str:
        head = (f"### Contract `{self.contract}` — "
                f"{'PASS' if self.ok else 'FAIL'} "
                f"({self.n_rows:,} rows, {len(self.errors)} errors, "
                f"{len(self.warnings)} warnings)")
        if not self.violations:
            return head + "\n\nNo violations.\n"
        rows = ["", "| severity | rule | column | rows | detail |",
                "|---|---|---|---:|---|"]
        for v in self.violations:
            rows.append(f"| {v.severity.value} | `{v.rule}` | "
                        f"{'`'+v.column+'`' if v.column else '—'} | "
                        f"{v.n_rows:,} | {v.detail} |")
        return head + "\n" + "\n".join(rows) + "\n"

    def to_json(self) -> str:
        return json.dumps(
            {"contract": self.contract, "n_rows": self.n_rows, "ok": self.ok,
             "violations": [v.as_dict() for v in self.violations]}, indent=2)


# --------------------------------------------------------------------------- #
# the engine
# --------------------------------------------------------------------------- #
def validate(df: pd.DataFrame, contract: Contract) -> ValidationReport:
    """Check ``df`` against ``contract`` and return every violation found.

    The engine never stops at the first problem: a report that lists all six
    broken columns is worth six debugging cycles.
    """
    rep = ValidationReport(contract=contract.name, n_rows=len(df))
    add = rep.violations.append

    if len(df) < contract.min_rows:
        add(Violation("min_rows", Severity.ERROR, None, len(df),
                      f"expected >= {contract.min_rows:,} rows, got {len(df):,}"))

    missing = [c for c in contract.column_names if c not in df.columns]
    if missing:
        add(Violation("missing_columns", Severity.ERROR, None, 0,
                      f"absent: {', '.join(missing)}"))

    if not contract.allow_extra_columns:
        extra = [c for c in df.columns if c not in contract.column_names]
        if extra:
            add(Violation("unexpected_columns", Severity.WARN, None, 0,
                          f"present but undeclared: {', '.join(map(str, extra))}"))

    for col in contract.columns:
        if col.name not in df.columns:
            continue
        s = df[col.name]

        if not _DTYPE_PREDICATES[col.dtype](s):
            add(Violation("dtype", Severity.ERROR, col.name, 0,
                          f"expected {col.dtype}, got {s.dtype}"))

        n_null = int(s.isna().sum())
        if n_null and not col.nullable:
            add(Violation("not_null", Severity.ERROR, col.name, n_null,
                          f"{n_null:,} null values in a non-nullable column"))

        if col.unique:
            n_dup = int(s.duplicated(keep=False).sum())
            if n_dup:
                add(Violation("unique", Severity.ERROR, col.name, n_dup,
                              f"{n_dup:,} rows share a duplicated value"))

        nn = s.dropna()
        if col.allowed is not None and len(nn):
            bad = ~nn.astype("string").isin(list(col.allowed))
            if int(bad.sum()):
                sample = sorted(set(nn[bad].astype("string")))[:3]
                add(Violation("allowed_values", Severity.ERROR, col.name,
                              int(bad.sum()),
                              f"values outside the allowed set, e.g. {sample}"))

        if col.min_value is not None and len(nn) and pdt.is_numeric_dtype(nn):
            bad = nn < col.min_value
            if int(bad.sum()):
                add(Violation("min_value", Severity.ERROR, col.name, int(bad.sum()),
                              f"{int(bad.sum()):,} rows below {col.min_value} "
                              f"(min observed {nn.min()})"))

        if col.max_value is not None and len(nn) and pdt.is_numeric_dtype(nn):
            bad = nn > col.max_value
            if int(bad.sum()):
                add(Violation("max_value", Severity.ERROR, col.name, int(bad.sum()),
                              f"{int(bad.sum()):,} rows above {col.max_value} "
                              f"(max observed {nn.max()})"))

        if col.regex is not None and len(nn):
            pat = re.compile(col.regex)
            bad = ~nn.astype("string").map(lambda v: bool(pat.fullmatch(v)))
            if int(bad.sum()):
                add(Violation("regex", Severity.ERROR, col.name, int(bad.sum()),
                              f"{int(bad.sum()):,} rows fail /{col.regex}/"))

    if contract.primary_key and all(k in df.columns for k in contract.primary_key):
        n_dup = int(df.duplicated(subset=list(contract.primary_key), keep=False).sum())
        if n_dup:
            add(Violation("primary_key", Severity.ERROR, None, n_dup,
                          f"{n_dup:,} rows duplicate the key "
                          f"({', '.join(contract.primary_key)})"))

    for chk in contract.checks:
        try:
            n_bad = int(chk.fn(df))
        except Exception as exc:                       # a broken check is itself a defect
            add(Violation(chk.name, Severity.ERROR, None, 0,
                          f"check raised {type(exc).__name__}: {exc}"))
            continue
        if n_bad:
            add(Violation(chk.name, chk.severity, None, n_bad,
                          chk.description or f"{n_bad:,} offending rows"))

    return rep


def write_report(reports: Sequence[ValidationReport], path) -> None:
    """Persist a run's contract reports as one Markdown artefact."""
    body = "\n".join(r.to_markdown() for r in reports)
    path.write_text("# Data quality report\n\n" + body, encoding="utf-8")
