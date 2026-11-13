#!/usr/bin/env bash
# Runs `pulumi policy lint` (the dev CLI in this repo's bin/) on a program folder with the ABI v2 AWS packs.
#
#   hackathon/static-scan/lint.sh <program dir> [lint flags...]
#
# Flags go straight to the command: --stack <name>, -c key=value, --json, --graph-out <file>.
# PACKS picks the packs directory (default ../policy-packs-internal-pure/dist-input); LINT_PACKS a space-separated
# subset of pack names.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
packs_dir="${PACKS:-$(cd "$repo/.." && pwd)/policy-packs-internal-pure/dist-input}"
names="${LINT_PACKS:-cis-aws cmmc-aws hitrust-aws iso-27001-aws nist-aws pci-dss-aws pulumi-best-practices-aws}"
args=()
for p in $names; do args+=(--policy-pack "$packs_dir/$p"); done
exec "$repo/bin/pulumi" policy lint "$@" "${args[@]}"
