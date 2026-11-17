#!/usr/bin/env bash
# Builds the pulumi-language-purejs plugin release: one tarball per platform, named the way the CLI's plugin download
# expects (pulumi-language-purejs-v<ver>-<os>-<arch>.tar.gz), plus checksums.txt.
#
#   hackathon/purejs-plugin/build-release.sh <version> [out dir]
#
# Publish on the fork (not a prerelease, so the CLI's "latest version" lookup finds it):
#   gh release create v<version> -R aacotroneo/pulumi --target <commit> --latest <out>/*.tar.gz <out>/checksums.txt
# Point a stock CLI at it:
#   PULUMI_PLUGIN_DOWNLOAD_URL_OVERRIDES='^github://api\.github\.com/pulumi/pulumi-purejs$=github://api.github.com/aacotroneo/pulumi'
set -euo pipefail
version="${1:?usage: build-release.sh <version> [out dir]}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="${2:-$repo/hackathon/purejs-plugin/dist}"
if [[ -n "$(git -C "$repo" status --porcelain --untracked-files=no -- pkg sdk)" ]]; then
    echo "pkg/ or sdk/ has uncommitted changes; the release must match a pushed commit" >&2
    exit 1
fi
mkdir -p "$out"
for platform in darwin-arm64 darwin-amd64 linux-amd64 linux-arm64 windows-amd64; do
    os="${platform%-*}" arch="${platform#*-}"
    stage="$(mktemp -d)"
    bin="pulumi-language-purejs"
    [[ "$os" == windows ]] && bin="$bin.exe"
    (cd "$repo/pkg" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -ldflags "-s -w" -o "$stage/$bin" ./cmd/pulumi-language-purejs)
    tar czf "$out/pulumi-language-purejs-v$version-$platform.tar.gz" -C "$stage" "$bin"
    rm -f "$stage/$bin" && rmdir "$stage"
done
(cd "$out" && shasum -a 256 pulumi-language-purejs-v"$version"-*.tar.gz >checksums.txt && cat checksums.txt)
git -C "$repo" rev-parse HEAD >"$out/COMMIT"
du -h "$out"/*.tar.gz
