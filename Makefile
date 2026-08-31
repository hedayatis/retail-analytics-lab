# Reproduce everything from a clean checkout.
PY      ?= python3
export PYTHONPATH := src

.PHONY: help setup data pipeline test parity-r lab clean-outputs all

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'

setup:            ## install python dependencies
	$(PY) -m pip install -e ".[dev]"

data: data/raw/onlineretail2.rda  ## fetch and verify the donor dataset

data/raw/onlineretail2.rda:
	$(PY) scripts/fetch_data.py

pipeline: data/raw/onlineretail2.rda  ## ingest -> clean -> warehouse -> analytics
	$(PY) -m retail_lab.cli pipeline

test:             ## run the test suite
	$(PY) -m pytest

parity-r:         ## run the base-R implementations under webR and diff them
	cd lab && npm install --silent && node run_r_parity.mjs

lab:              ## build the browser lab data bundle
	$(PY) -m retail_lab.cli export-lab

clean-outputs:    ## delete generated artefacts (keeps the raw donor file)
	rm -rf data/processed/* data/reports/*

all: pipeline lab test  ## the full reproduction
