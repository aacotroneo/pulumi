#!/usr/bin/env bash
# Scans the showcase program with the guardrails pack, as dev and as prod, and checks every finding against the
# `// violates: <policy>[(<stack>)]` markers in the code.
#
# Uses the dev CLI from the hackathon/scan-guardrails worktree (its SDK is picked up next to it) and the lean purejs
# host from the purejs PR worktree. Override with PULUMI=... and PUREJS_HOST_DIR=...
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
G="$HOME/go/src/github.com/pulumi"
PULUMI="${PULUMI:-$G/pulumi-scan-guardrails/bin/pulumi}"
export PATH="${PUREJS_HOST_DIR:-$G/pulumi-purejs-pr/bin}:$PATH"
export PULUMI_SKIP_UPDATE_CHECK=1
mkdir -p "$HERE/results"
for stack in dev prod; do
    "$PULUMI" policy scan "$HERE/program" --policy-pack "$HERE/pack" --stack "$stack" --json \
        > "$HERE/results/scan-$stack.json" 2> >(grep -v '^warning: using pulumi-language-purejs' >&2)
    "$PULUMI" policy scan "$HERE/program" --policy-pack "$HERE/pack" --stack "$stack" \
        > "$HERE/results/scan-$stack.txt" 2>&1
    echo "$stack: $(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); f=r["findings"]; print(len(f), "findings,", sum(x["enforcementLevel"]=="mandatory" for x in f), "mandatory,", r["timings"]["totalMs"], "ms")' "$HERE/results/scan-$stack.json")"
done
python3 "$HERE/check.py" "$HERE/program" "$HERE/results/scan-dev.json" "$HERE/results/scan-prod.json"
