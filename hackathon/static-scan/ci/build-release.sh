#!/usr/bin/env bash
# Builds the linux-x64 bundle the PR-check POC downloads: the `pulumi` CLI (with `policy lint`) plus the patched
# @pulumi/pulumi it runs programs with.
#
#   hackathon/static-scan/ci/build-release.sh [out dir]   → <out>/pulumi-lint-linux-x64.tgz and .sha256
#
# Publish (prerelease on the public fork):
#   gh release create <tag> -R aacotroneo/pulumi --prerelease --target hackathon/static-scan <out>/pulumi-lint-linux-x64.tgz*
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="${1:-$repo/hackathon/static-scan/ci/dist}"
if [[ -n "$(git -C "$repo" status --porcelain --untracked-files=no -- pkg sdk)" ]]; then
    echo "pkg/ or sdk/ has uncommitted changes; the bundle must match a pushed commit" >&2
    exit 1
fi
stage="$out/pulumi-lint"
mkdir -p "$out"
[[ -e "$stage" ]] && mv "$stage" "$(mktemp -d "$out/old.XXXXXX")"
mkdir -p "$stage"

(cd "$repo/sdk/nodejs" && npx --no-install tsc)
(cd "$repo/pkg" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "-s -w" -o "$stage/pulumi" ./cmd/pulumi)
cp -R "$repo/sdk/nodejs/bin" "$stage/sdk"
(cd "$stage/sdk" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
git -C "$repo" rev-parse HEAD >"$stage/COMMIT"

(cd "$out" && tar czf pulumi-lint-linux-x64.tgz pulumi-lint && shasum -a 256 pulumi-lint-linux-x64.tgz >pulumi-lint-linux-x64.tgz.sha256)
cat "$out/pulumi-lint-linux-x64.tgz.sha256"
du -h "$out/pulumi-lint-linux-x64.tgz"
