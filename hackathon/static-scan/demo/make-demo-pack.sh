#!/usr/bin/env bash
# Builds the demo pack: pulumi-best-practices-aws (ABI v2) without the tagging policies, plus demo-policies.js.
# The output goes to the private packs checkout (../policy-packs-internal-pure/dist-demo/aws-demo), never this repo.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ppi="$(cd "$here/../../../.." && pwd)/policy-packs-internal-pure"
src="$ppi/dist-input/pulumi-best-practices-aws"
out="$ppi/dist-demo/aws-demo"
mkdir -p "$out"
{
    # The bundle's registerPack honours __pulumiPolicyFilter: drop the tagging policies (noise in a demo).
    echo 'globalThis.__pulumiPolicyFilter = (p) => (/tagging/.test(p.name) ? undefined : p);'
    cat "$src/policies.js"
    echo
    echo 'delete globalThis.__pulumiPolicyFilter;'
    echo 'globalThis.__pulumiPolicyPack.name = "aws-demo";'
    cat "$here/demo-policies.js"
} > "$out/policies.js"
cat > "$out/PulumiPolicy.yaml" <<YAML
runtime: purejs
main: policies.js
version: 0.1.0
description: "Demo: AWS best practices without tagging, plus a policy that links resources through outputs."
YAML
echo "$out"
