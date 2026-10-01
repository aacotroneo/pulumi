#!/usr/bin/env python3
"""Per-package symbol-size diff between the base and goja CLI builds (unstripped, from `go tool nm -size`)."""
import collections, json, os, re, sys
D = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".build", "cli-size")
R = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "results")

def pkg_of(sym):
    s = sym
    for pre in ("type:.eq.", "type:", "go:itab.", "go:link.", "go:info.", "go:cuinfo.", "gclocals·", "go:string.", "*"):
        if s.startswith(pre):
            s = s[len(pre):]
    s = s.lstrip("*[]()")
    # package path = up to the last '/' then up to the first '.'
    i = s.rfind("/")
    j = s.find(".", i + 1)
    return s[:j] if j > 0 else s

def load(name):
    by = collections.Counter()
    for line in open(os.path.join(D, name)):
        parts = line.split(None, 3)
        if len(parts) < 4 or parts[2] not in "TtRrDdBb":
            continue
        by[pkg_of(parts[3].strip())] += int(parts[1])
    return by

base, goja = load("nm-base.txt"), load("nm-goja.txt")
def group(p):
    if p.startswith("github.com/dop251/goja"): return "goja (engine)"
    if p.startswith("github.com/dlclark/regexp2"): return "regexp2/v2 (goja's fallback regex engine)"
    if p.startswith("github.com/go-sourcemap"): return "go-sourcemap"
    if p.startswith("golang.org/x/text"): return "golang.org/x/text (newly linked packages)"
    if p == "github.com/pulumi/pulumi/pkg/v3/resource/plugin": return "pulumi plugin pkg (purejs analyzer + prelude)"
    if p == "runtime": return "Go runtime tables for the new code (pclntab)"
    if p in ("_type:*", "typerel", "go:func", "", "_go:funcdescrel"): return "Go type/func metadata for the new code"
    return "other"
delta = collections.Counter()
detail = collections.Counter()
for p in set(base) | set(goja):
    d = goja[p] - base[p]
    if d:
        delta[group(p)] += d
        detail[p] = d
out = {
    "symbol_bytes_base": sum(base.values()), "symbol_bytes_goja": sum(goja.values()),
    "delta_by_group": dict(delta.most_common()),
    "top_packages": [{"pkg": p, "delta": d} for p, d in detail.most_common(25)],
    "unstripped_file_bytes": {"base": os.path.getsize(os.path.join(D, "sym-base")), "goja": os.path.getsize(os.path.join(D, "sym-goja"))},
}
json.dump(out, open(os.path.join(R, "cli-size-breakdown.json"), "w"), indent=2)
print(json.dumps(out, indent=1))
