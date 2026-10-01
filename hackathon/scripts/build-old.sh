#!/usr/bin/env bash
# Builds the 7 old (nodejs) packs in place in ../policy-packs-internal and records build times and sizes.
set -euo pipefail
source "$(dirname "$0")/common.sh"
export NODE_OPTIONS="--max-old-space-size=8192"
out="$RESULTS_DIR/old-build.jsonl"
: > "$out"
for entry in "${PACKS[@]}"; do
  dir="${entry%%:*}"; name="${entry##*:}"
  start=$(python3 -c 'import time; print(time.time())')
  (cd "$PPI_DIR/$dir" && npm run build >/dev/null 2>&1) || { echo "BUILD FAILED: $name"; continue; }
  end=$(python3 -c 'import time; print(time.time())')
  bytes=$(stat -f%z "$PPI_DIR/$dir/index.js")
  gz=$(gzip -c "$PPI_DIR/$dir/index.js" | wc -c | tr -d ' ')
  secs=$(python3 -c "print(round($end-$start,2))")
  echo "{\"pack\":\"$name\",\"dir\":\"$dir\",\"build_s\":$secs,\"index_js_bytes\":$bytes,\"index_js_gzip_bytes\":$gz}" | tee -a "$out"
done
