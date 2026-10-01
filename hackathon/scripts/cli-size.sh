#!/usr/bin/env bash
# Builds the pulumi CLI from the base commit (no goja) and from this working tree (goja + purejs analyzer) with the
# release flags from .goreleaser.yml, for each GOOS/GOARCH, and records raw/gzipped sizes plus a per-package breakdown.
set -euo pipefail
source "$(dirname "$0")/common.sh"
BASE="${BASE:-$(git -C "$REPO_DIR" rev-parse --short HEAD)}"
OUT="$HACK_DIR/.build/cli-size"; mkdir -p "$OUT"
WT="$HACK_DIR/.build/cli-size/base-worktree"
if [[ ! -d "$WT" ]]; then git -C "$REPO_DIR" worktree add --detach "$WT" "$BASE" >/dev/null; fi
FLAGS=(-trimpath -tags osusergo,grpcnotrace -ldflags "-w -s -X github.com/pulumi/pulumi/sdk/v3/go/common/version.Version=v3.999.0-bench")
TARGETS="${TARGETS:-darwin/arm64 linux/amd64 windows/amd64}"
res="$RESULTS_DIR/cli-size.jsonl"; : > "$res"
for t in $TARGETS; do
  os="${t%/*}"; arch="${t#*/}"; ext=""; [[ "$os" == windows ]] && ext=".exe"
  for variant in base goja; do
    src="$REPO_DIR"; [[ "$variant" == base ]] && src="$WT"
    bin="$OUT/pulumi-$variant-$os-$arch$ext"
    (cd "$src/pkg" && CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build "${FLAGS[@]}" -o "$bin" ./cmd/pulumi)
    raw=$(stat -f%z "$bin"); gz=$(gzip -9 -c "$bin" | wc -c | tr -d ' ')
    echo "{\"variant\":\"$variant\",\"goos\":\"$os\",\"goarch\":\"$arch\",\"bytes\":$raw,\"gzip_bytes\":$gz,\"src\":\"$( [[ $variant == base ]] && echo "$BASE" || echo "$BASE+working-tree")\"}" | tee -a "$res"
  done
done
