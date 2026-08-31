# Findings — UCI Online Retail II

All figures below are produced by `make pipeline`. RFM outputs are checked
across pandas, pure Python, DuckDB SQL and base R; cohort outputs are checked
across pandas, DuckDB SQL and base R.
Reference date for recency is **2011-12-10**, the day after the last transaction.

| | |
|---|---|
| Trading window | 2009-12-01 → 2011-12-09 |
| Raw transaction lines | 1,067,371 |
| Clean sales lines | 1,003,214 |
| Return / cancellation lines | 19,104 |
| Clean sales revenue before returns | £19,642,692.15 |
| Returned value | −£1,462,797.75 (7.45% of revenue) |
| Orders | 39,516 |
| Average order value | £497.08 |
| Distinct products sold | 4,877 |
| Identified customers | 5,852 |

---

## 1. This is a wholesale business wearing a retail costume

The average order is **£497** across 4,877 products, and Champions place an
average of **16.2 orders each**. That is not consumer gift-shopping behaviour;
it is a trade counter serving small independent retailers, and it governs how
every other number should be read. Median-basket intuitions from B2C e-commerce
will mislead here.

## 2. Revenue is extraordinarily concentrated

The top 20% of identified customers account for **77.2%** of attributed revenue.
Broken out by RFM segment:

| Segment | Customers | % of customers | Revenue | % of revenue |
|---|---:|---:|---:|---:|
| Champions | 1,395 | 23.8% | £11,706,286 | 68.6% |
| Loyal customers | 1,185 | 20.3% | £2,474,396 | 14.5% |
| Cannot lose them | 286 | 4.9% | £950,162 | 5.6% |

**Champions are 23.8% of the customer base and 68.6% of revenue.** The
commercial implication is that account management, not acquisition marketing, is
the lever with the most money behind it — and that the 286 "Cannot lose them"
accounts (high frequency, gone quiet) are worth £950k of demonstrated annual
spend and are individually nameable.

## 3. Retention is genuinely good, and it is the business model

Average month-1 repeat rate across cohorts is **21.0%** (range 9.2%–35.0%), and
it does not decay to nothing: average month-6 retention is **17.9%**. The
December 2009 cohort was still **37.6% active twelve months later**.

A flat-tailed retention curve like this is the signature of a *replenishment*
business. It also means cohort quality is a leading indicator worth monitoring:
the 2010-12 cohort (76 customers, 9.2% at M+1) is a visible outlier against
neighbours running at 17–26%.

## 4. Nearly a quarter of transactions cannot be attributed to anyone

**22.6% of clean sales lines carry no customer id** — 13.1% of revenue. These
are genuine guest checkouts, not a data defect, and they are silently excluded
from every customer-level analysis in this and most published work on the
dataset. Stating the exclusion is the honest move: RFM here describes 86.9% of
revenue, not 100%.

## 5. Geographic concentration is near-total

**85.5% of revenue is United Kingdom.** The remaining 42 countries share 14.5%,
which makes country-level cuts statistically thin almost everywhere outside the
UK, EIRE, Germany, France and the Netherlands.

## 6. The data quality findings are themselves the story

The cleaning ledger (`data/reports/cleaning_ledger.csv`) prices every decision:

| Rule | Rows removed | Gross value | Why |
|---|---:|---:|---|
| `exact_duplicate` | 34,335 | £431,717 | byte-identical lines across 5,391 invoices |
| `routed_to_returns` | 22,497 | −£1,462,051 | cancellations and negative quantities |
| `non_product_stock_code` | 4,753 | £822,506 | postage, manual credits, bank charges, samples |
| `zero_value_return` | 3,393 | £0 | stock write-offs, not customer returns |
| `non_positive_price` | 2,566 | £0 | inventory corrections ("check", "?", "damages") |
| `ledger_adjustment` | 6 | −£147,614 | `A`-prefixed bad-debt postings |

Two of these are worth dwelling on.

**The six `A` rows.** Three bad-debt adjustments carrying −£53,594, −£44,032 and
−£38,926, plus a +£11,062 posting and two −£11,062 reversals. Six rows out of a
million, worth £147,614 of distortion, and none of them a sale. Any analysis
that filters only on `Quantity > 0` keeps the +£11,062 one and silently inflates
revenue.

**The 34,335 duplicates.** Byte-identical invoice lines — same invoice, product,
timestamp, quantity and price. Removing them costs £431,717 of apparent revenue,
roughly 2%. The opposite reading (a customer genuinely bought the same item on
two scans of one invoice) is defensible. What is not defensible is choosing
silently, so the ledger prices it and the rule is one line to reverse.

---

## Method notes worth stating

- **Recency is calendar days**, not a timestamp difference. Subtracting raw
  timestamps floors a 2011-12-09 13:00 purchase to 0 days from a 2011-12-10
  reference, while date arithmetic gives 1 — enough to move customers across an
  `r_score` boundary.
- **Scores are defined on values, not row ranks.** `NTILE(5)`/`qcut` split runs
  of tied values by row order, and ~40% of customers have `frequency = 1`. See
  the parity section of the lab for the demonstration.
- **Cohort cells beyond a cohort's horizon are omitted, not zero-filled.** A
  cohort acquired in the final month has not failed to retain at M+6.
