#!/usr/bin/env bash
# Stages the built old packs as `old-<name>` under hackathon/.build/old/<name>/, ready to publish or run locally.
# pulumi-best-practices comes from a HEAD worktree (PBP_INDEX) because the working tree has a WIP edit that fails tsc.
set -euo pipefail
source "$(dirname "$0")/common.sh"
STAGE="$HACK_DIR/.build/old"
PBP_INDEX="${PBP_INDEX:-}"
rm -rf "$STAGE" && mkdir -p "$STAGE"
for entry in "${PACKS[@]}"; do
  dir="${entry%%:*}"; name="${entry##*:}"
  out="$STAGE/old-$name"; mkdir -p "$out"
  src_index="$PPI_DIR/$dir/index.js"
  if [[ "$name" == "pulumi-best-practices-aws" && -n "$PBP_INDEX" ]]; then src_index="$PBP_INDEX"; fi
  sed "s/PolicyPack(\"$name\"/PolicyPack(\"old-$name\"/" "$src_index" > "$out/index.js"
  grep -q "PolicyPack(\"old-$name\"" "$out/index.js" || { echo "rename failed for $name"; exit 1; }
  cp "$PPI_DIR/$dir/package.json" "$out/package.json"
  # PulumiPolicy.yaml has no name field that the CLI reads; drop the ignored `name:` key to avoid confusion.
  grep -v '^name:' "$PPI_DIR/$dir/PulumiPolicy.yaml" > "$out/PulumiPolicy.yaml"; echo >> "$out/PulumiPolicy.yaml"
  ln -s "$PPI_DIR/node_modules" "$out/node_modules"
  echo "staged old-$name ($(du -h "$out/index.js" | cut -f1))"
done
