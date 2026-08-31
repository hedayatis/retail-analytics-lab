# Changelog

## [1.0.0] - 2026-08-31

**Status:** release

### Summary

Initial public portfolio release of the reproducible Retail Analytics Lab over
the UCI Online Retail II dataset.

### Added

- Contract-driven ingestion and cleaning with a priced decision ledger.
- DuckDB star schema, RFM segmentation and acquisition-cohort retention.
- Cross-engine implementations in pandas, pure Python, SQL and base R, with
  parity checks over the applicable outputs.
- Checksum-verified data retrieval from the authoritative package repository.
- Interactive browser lab powered by webR and Pyodide.
- A compact, cohort-stratified 25-customer browser sample for responsive
  WebAssembly execution, alongside full-population result summaries.
- Automated pipeline, test and lab checks through GitHub Actions.

### Changed

- Clarified that RFM has four implementations while cohort retention has three.
- Relabeled sales revenue so returns are not implicitly treated as deducted.

### Validation

- Source dataset SHA-256 verification: passed.
- Python and JavaScript syntax checks: passed.
- GitHub Actions pipeline: passed on Python 3.12 and Node 20.
- Full-data contracts: 4/4 passed over 1,067,371 source rows.
- Cross-language parity: passed; base R and Python agreed on every checked
  column for RFM and cohort retention.
- Test suite: 60/60 passed.
- Browser-lab bundle build: passed.

### Compatibility and migration

- Initial release; no migration is required.

### Known limitations

- The downloaded dataset is supplied for non-commercial use only under the
  donor's stated permission; the MIT license applies to project code, not data.
- Browser execution loads WebAssembly runtimes from jsDelivr unless they are
  vendored locally.
