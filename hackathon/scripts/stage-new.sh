#!/usr/bin/env bash
# Stages the purejs bundles from the M1 worktree (dist-pure/<name>/) into hackathon/.build/new/<name>/.
set -euo pipefail
source "$(dirname "$0")/common.sh"
STAGE="$HACK_DIR/.build/new"
NEW_PREFIX="${NEW_PREFIX:-}"
rm -rf "$STAGE" && mkdir -p "$STAGE"
out="$RESULTS_DIR/new-bundles.jsonl"; : > "$out"
for entry in "${PACKS[@]}"; do
  name="${entry##*:}"
  src="$PPI_PURE_DIR/dist-pure/$name"
  [[ -f "$src/policies.js" ]] || { echo "missing $src/policies.js"; exit 1; }
  dst="$STAGE/$NEW_PREFIX$name"; mkdir -p "$dst"
  # VERSION_SUFFIX: the service keeps deleted version tags, so a republish needs a fresh tag.
  sed "s/^version: \(.*\)$/version: \1${VERSION_SUFFIX:-}/" "$src/PulumiPolicy.yaml" > "$dst/PulumiPolicy.yaml"
  if [[ -n "$NEW_PREFIX" ]]; then
    # Rename the pack inside the bundle (only needed if the plain name is taken by a nodejs pack on the service).
    sed "s/name:\"$name\"/name:\"$NEW_PREFIX$name\"/; s/name: \"$name\"/name: \"$NEW_PREFIX$name\"/" "$src/policies.js" > "$dst/policies.js"
  else
    cp "$src/policies.js" "$dst/"
  fi
  bytes=$(stat -f%z "$dst/policies.js"); gz=$(gzip -c "$dst/policies.js" | wc -c | tr -d ' ')
  tgz=$(tar czf - -C "$dst" . | wc -c | tr -d ' ')
  echo "{\"pack\":\"$NEW_PREFIX$name\",\"policies_js_bytes\":$bytes,\"policies_js_gzip_bytes\":$gz,\"tarball_bytes\":$tgz}" | tee -a "$out"
done
