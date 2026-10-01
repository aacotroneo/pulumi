#!/usr/bin/env bash
# Publishes every pack dir under hackathon/.build/<old|new>/ to $ORG, recording publish time and tarball size.
set -euo pipefail
source "$(dirname "$0")/common.sh"
mode="${1:?usage: publish.sh <old|new>}"
PULUMI="${PULUMI:-pulumi}"
out="$RESULTS_DIR/publish-$mode.jsonl"
: > "$out"
for d in "$HACK_DIR/.build/$mode"/*/; do
  name="$(basename "$d")"
  start=$(python3 -c 'import time; print(time.time())')
  if (cd "$d" && "$PULUMI" policy publish "$ORG" > "$RESULTS_DIR/publish-$mode-$name.log" 2>&1); then ok=true; else ok=false; fi
  end=$(python3 -c 'import time; print(time.time())')
  secs=$(python3 -c "print(round($end-$start,2))")
  echo "{\"mode\":\"$mode\",\"pack\":\"$name\",\"ok\":$ok,\"publish_s\":$secs}" | tee -a "$out"
done
