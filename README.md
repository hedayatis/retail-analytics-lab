# Retail Analytics Lab

[![pipeline](https://github.com/hedayatis/retail-analytics-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/hedayatis/retail-analytics-lab/actions/workflows/ci.yml)

**[Open the live browser lab](https://hedayatis.github.io/retail-analytics-lab/)**

Current revision: **1.1.0**. Release history and validation are recorded in
`CHANGELOG.md`. GitHub Pages uses a unique artifact per workflow run and retry.

**A reproducible analytics pipeline over 1,067,371 real transactions, with RFM
implemented four ways and cohort retention three ways, backed by parity tests.**

Built on the UCI **Online Retail II** dataset, with established RFM and cohort
methods. Chen, Sain & Guo (2012) provide a related retail RFM case study.

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
| **24 dashboard checks** | Protect source rendering, period filters, weighted retention, denominators, sample comparisons and interface structure. |

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

`lab/` opens as an analytical dashboard, not a script notebook:

- Revenue-period and metric controls, weighted average order value, complete-month
  YoY comparisons, monthly values and CSV export.
- Full-history market shares (including other countries), customer/revenue share
  comparisons, segment details and evidence-based interpretation cards.
- Cohort-size-weighted repeat-purchase curves, eligibility counts, and a retention
  heatmap distinguishing unobserved and partial months.
- Cleaning-rule counts and revenue attribution coverage, with the audit ledger.

The dashboard uses **precomputed full-population aggregates** in `data/results.json`.
Filters and derived insights recalculate immediately in JavaScript. Revenue
controls affect only the revenue KPIs/trend; customer and country views remain
full-history, while the retention curve has its own acquisition-year selector.
Historical revenue excludes returns and is not profit. Segment revenue includes
identified customers only. Retention is monthly repeat purchasing, not survival
or predicted churn; its weighted percentages are approximate because input
percentages are rounded to two decimals. December 2011 is incomplete and is
excluded from default revenue and retention comparisons.

The separate live-validation panel loads **webR** and **Pyodide** on demand and
executes R/Python on a cohort-stratified sample of 25 real customers (2,230 lines).
Structured results appear without opening code. The sample is for technical
validation, not population estimation, and does not replace the dashboard data.
Editable source and execution logs are behind optional, closed disclosure panels.
Collapsing source is a presentation choice, not source-code confidentiality.

```
cd lab && npm install && npm run serve      # http://localhost:8080
npm run vendor                              # optional: run fully offline
node --test tests/dashboard.test.mjs         # no additional test dependencies
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

The [current UCI direct dataset listing](https://archive.ics.uci.edu/dataset/502/online+retail+ii)
states CC BY 4.0. This repository still uses the separate package redistribution
and retains its source-specific non-commercial notice. This revision does not
relicense that package or silently replace its notice.

## Contribution and originality scope

This is an engineering portfolio implementation using third-party data, open-source
tools and established analytical methods. It does not claim invention of RFM,
cohort analysis, database star schemas, or the source dataset. Development and
publication include AI assistance. The uploaded starting package has not had an
independent line-by-line authorship audit; passing tests and publishing under an
account do not establish originality or exclusive ownership. Dependency licences
remain separate from the repository's code licence.

Revision 1.1.0 adds the dashboard/interface, derived-insight calculations,
source-highlighting repair and 24 frontend regressions. It does not change the
underlying RFM/cohort pipeline or source dataset. See
[`docs/revisions/1.1.0.md`](docs/revisions/1.1.0.md) for formulas and scope.

---

*Sam (Sajjad Hedayati)*
