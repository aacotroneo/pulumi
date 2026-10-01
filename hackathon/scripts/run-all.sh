#!/usr/bin/env bash
# Runs the whole benchmark matrix sequentially (so runs don't compete for CPU), then the parity diffs.
set -uo pipefail
cd "$(dirname "$0")/.."
./scripts/bench.py old cloud --runs "${RUNS:-2}" --verbose
./scripts/bench.py new cloud --runs "${RUNS_NEW:-3}" --verbose
./scripts/bench.py old local --runs 3 --verbose
./scripts/bench.py new local --runs 3 --verbose
./scripts/parity.py cloud
./scripts/parity.py local
