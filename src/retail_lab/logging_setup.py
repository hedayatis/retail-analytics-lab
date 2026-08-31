"""Structured, run-scoped logging.

Each pipeline invocation gets a run id; every log line carries it, and the run
manifest written at the end references the same id. That is what makes a failed
run reconstructable after the fact rather than a mystery.
"""
from __future__ import annotations

import logging
import os
import sys
import time
import uuid
from contextlib import contextmanager

RUN_ID = os.environ.get("RETAIL_LAB_RUN_ID") or uuid.uuid4().hex[:12]

_FMT = "%(asctime)s | %(levelname)-7s | run=%(run_id)s | %(name)-22s | %(message)s"


class _RunIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.run_id = RUN_ID
        return True


def configure(level: str = "INFO") -> None:
    root = logging.getLogger("retail_lab")
    if root.handlers:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(_FMT, datefmt="%H:%M:%S"))
    handler.addFilter(_RunIdFilter())
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    root.propagate = False


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"retail_lab.{name}")


@contextmanager
def stage(log: logging.Logger, name: str):
    """Time a pipeline stage and always report its outcome."""
    log.info("stage start   : %s", name)
    t0 = time.perf_counter()
    try:
        yield
    except Exception:
        log.error("stage FAILED  : %s after %.2fs", name, time.perf_counter() - t0)
        raise
    log.info("stage complete: %s in %.2fs", name, time.perf_counter() - t0)
