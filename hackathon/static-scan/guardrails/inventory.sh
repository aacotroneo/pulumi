#!/usr/bin/env bash
# inventory.sh [program dir] [stack]: golden-path adoption for a program, from one scan with the inventory pack.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
G="$HOME/go/src/github.com/pulumi"
PULUMI="${PULUMI:-$G/pulumi-scan-guardrails/bin/pulumi}"
export PATH="${PUREJS_HOST_DIR:-$G/pulumi-purejs-pr/bin}:$PATH"
"$PULUMI" policy scan "${1:-$HERE/program}" --policy-pack "$HERE/pack-inventory" --stack "${2:-dev}" --json 2> /dev/null |
    python3 -c 'import json, sys
r = json.load(sys.stdin)
for f in r["findings"]:
    if f["policy"] == "golden-path-inventory":
        print(json.dumps(json.loads(f["message"].split("\n", 1)[1]), indent=1))'
