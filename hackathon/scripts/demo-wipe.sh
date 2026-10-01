#!/usr/bin/env bash
# Wipes the cached policy packs for the demo so the next `pulumi up` is a true cold start.
set -euo pipefail
dir="$HOME/.pulumi/policies/pulumi_local"
echo "Policy cache before: $(du -sh "$dir" 2>/dev/null | cut -f1)"
rm -rf "$dir"/pulumi-analyzer-*-purejs* "$dir"/pulumi-analyzer-old-*
echo "Policy cache after:  $(du -sh "$dir" 2>/dev/null | cut -f1)"
