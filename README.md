# Retail Analytics Lab

[![pipeline](https://github.com/hedayatis/retail-analytics-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/hedayatis/retail-analytics-lab/actions/workflows/ci.yml)

**[Open the live browser lab](https://hedayatis.github.io/retail-analytics-lab/)**

Current revision: **1.0.1**. Release history and validation are recorded in
`CHANGELOG.md`. GitHub Pages uses a unique artifact per workflow run and retry.

**A reproducible analytics pipeline over 1,067,371 real transactions, with RFM
implemented four ways and cohort retention three ways, backed by parity tests.**

Built on the UCI **Online Retail II** dataset — the transactions behind Chen,
Sain & Guo (2012), the paper that made RFM segmentation a standard technique on
this class of data. Real data, real defects, no synthetic filler.

The point of this repository is not "here is a chart of some sales". It is:
*here is how I build the thing that produces the chart, and here is the evidence
it is right.*

```
make pipeline      # ingest -> clean -> warehouse -> analytics   (~25 s)
make test          # 60 unit, integration and parity tests
make parity-r      # run the base-R implementations under WebAssembly and diff
```

On the first run, `make pipeline` downloads the 5.5 MB donor-permitted dataset
from the authoritative `onlineretail2` package repository and verifies it
against the committed SHA-256 checksum before ingestion.

---

## What is actually in here

| | |
|---|---|
| **Data contracts** | A ~200-line declarative validation engine. Every stage boundary declares the shape it emits; an ERROR-severity violation aborts the run instead of propagating into an aggregate three steps later. |
| **A cleaning ledger** | Cleaning is a decision log, not a filter chain. Each rule records rows in, rows removed, rows out and **the revenue it cost**, so a reviewer can price a judgement call and reverse it in one line. |
| **A DuckDB star schema** | Declared grain per table, surrogate keys, and four referential/arithmetic integrity checks that run after every build. |
| **Cross-engine parity** | RFM is implemented in pandas, pure Python, DuckDB SQL and base R; cohort retention is implemented in pandas, DuckDB SQL and base R. The parity harness checks comparable outputs row-for-row. |
| **A live browser lab** | `lab/index.html` runs the real R and Python **in the visitor's browser** via WebAssembly, on real data, and diffs them in front of you. |
| **60 tests** | Unit tests use hand-built fixtures where the answer is known, while integration tests assert invariants against the full million rows. |

## The part I would defend in an interview

RFM is implemented four ways and cohort retention three ways, across distinct
execution models, with parity tests over their comparable outputs.
Cross-implementation parity catches **definitional** drift that no
single-language test can see.

It has already earned its place three times in this repository:

1. **A one-day recency disagreement.** Python subtracted raw timestamps, so a
   purchase at 13:00 on 9 December was 0 days from a 10 December reference;
   SQL and R worked on dates and said 1. That silently moved customers across an
   `r_score` boundary. Fixed at the definition — recency is whole calendar days —
   not papered over with a tolerance in the test.
2. **A silent 3,393-row drop.** The returns finaliser discarded zero-value
   write-off lines without recording them. The ledger now accounts for them.
3. **Calendar-month arithmetic.** 31 Jan → 1 Mar is 29 days but two calendar
   months. `days / 30.44` drifts a whole index over a two-year window; all three
   implementations compute `12·Δyear + Δmonth`.

### The tie trap

The obvious way to score RFM is `NTILE(5)` in SQL, `pd.qcut` in pandas,
`cut(quantile(...))` in R. All three claim to make quintiles. **All three
disagree on this data**, because ~40% of customers have `frequency = 1` and
`NTILE` splits a run of tied values across bucket boundaries *by row order*.
Two customers who behaved identically get different scores.

Scores here are defined on values, not row positions:

```
breaks = quantile(x, [.20, .40, .60, .80])    # type 7
ascending  score = 1 + #{b in breaks : x > b}
descending score = 5 - #{b in breaks : x > b}
```

R's `quantile(type=7)`, numpy's `method="linear"` and DuckDB's `quantile_cont`
are the same estimator, which is why four implementations land on identical
breakpoints. `tests/test_rfm.py::test_ntile_would_split_ties_and_ours_does_not`
demonstrates the defect rather than asserting it in a comment.

## Layout

```
src/retail_lab/
  contracts.py          the validation engine (dependency-free)
  schemas.py            contracts for every stage boundary
  ingest.py             checksum-verified read of the donor .rda
  clean.py              the rule ladder + cleaning ledger
  warehouse.py          DuckDB star schema build + integrity checks
  analytics/rfm.py      RFM (pandas)
  analytics/rfm_stdlib.py   RFM (standard library only — what the browser runs)
  analytics/cohort.py   acquisition-cohort retention
  cli.py                `python -m retail_lab.cli pipeline`
sql/
  01_star_schema.sql    fact/dimension DDL with declared grain
  02_rfm.sql            RFM in SQL
  03_cohort_retention.sql
R/
  rfm.R                 RFM in base R
  cohort.R              cohort retention in base R
tests/                  60 unit, integration and parity checks
lab/                    the browser lab (webR + Pyodide)
docs/findings.md        what the data actually says
```

## The browser lab

`lab/` is a static site that loads two WebAssembly runtimes on demand — **webR**
(a complete R 4.6) and **Pyodide** — and executes the repository's own R and
Python source on a cohort-stratified sample of 25 real customers. Nothing is
pre-rendered; the visitor can edit the code and re-run it, and the parity
harness diffs the two languages live.

```
cd lab && npm install && npm run serve      # http://localhost:8080
npm run vendor                              # optional: run fully offline
```

By default the runtimes load from jsDelivr, so the folder can be published to
GitHub Pages as-is. `npm run vendor` copies them into `lab/vendor/`, which the
page prefers when present.

The R is **base R only** — no dplyr, no data.table. That is a deliberate
constraint: the lab has to work on first load without reaching a CRAN mirror.

## Reproducing

```bash
python -m pip install -e ".[dev]"
make pipeline        # writes data/processed/ and data/reports/
make test
make parity-r        # needs Node; installs webR from npm
```

Every run writes `data/reports/run_manifest.json` (run id, source SHA-256, row
counts, revenue, contract status) and `data/reports/data_quality.md`. The source
file's checksum is verified against a committed sidecar before a single row is
read — if the upstream file is swapped, the run aborts rather than quietly
analysing different data.

## Data licence — please read

The dataset is © the donor, **Dr Daqing Chen** (London South Bank University),
and is redistributed by the `onlineretail2` R package with his permission **for
non-commercial purposes only**. This non-commercial portfolio project downloads
the data from that package source on demand; the binary is not stored in this
repository. Do not use the data commercially.

Cite: Chen, D., Sain, S.L., & Guo, K. (2012). *Data mining for the online retail
industry: a case study of RFM model-based customer segmentation using data
mining.* Journal of Database Marketing & Customer Strategy Management, 19(3),
197–208.

The code in this repository is MIT licensed; the data is not mine to license.

---

*Sam (Sajjad Hedayati)*
