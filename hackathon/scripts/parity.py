#!/usr/bin/env python3
"""Diffs the policy violations of old vs new for a path (cloud|local). Writes results/parity-<path>.{diff,json}."""
import json, os, re, sys, difflib
HACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = os.path.join(HACK, "results")
path = sys.argv[1] if len(sys.argv) > 1 else "cloud"
def norm(msg):
    # Noise that isn't a behavior difference: random auto-name suffixes, the old- pack prefix and -purejs version tag.
    msg = re.sub(r"-[0-9a-f]{7}\b", "-<rand>", msg)
    msg = re.sub(r"'old-([a-z0-9-]+)@", r"'\1@", msg)
    msg = re.sub(r"bench-(old|new|local)", "bench", msg)
    return msg.replace("-purejs'", "'")
def load(mode):
    vs = json.load(open(os.path.join(R, f"violations-{mode}-{path}.json")))
    return sorted(f"{v['pack']} | {v['policy']} | {v['level']} | {norm(v['urn'].split('::')[-1])} | {norm(v['message'])}".replace("\n", " ⏎ ") for v in vs)
old, new = load("old"), load("new")
diff = list(difflib.unified_diff(old, new, "old", "new", lineterm="", n=0))
open(os.path.join(R, f"parity-{path}.diff"), "w").write("\n".join(diff) + "\n")
so, sn = set(old), set(new)
summary = {"path": path, "old": len(old), "new": len(new), "matching": len(so & sn),
           "only_old": len(so - sn), "only_new": len(sn - so),
           "only_old_by_policy": sorted({l.split(" | ")[1] for l in so - sn}),
           "only_new_by_policy": sorted({l.split(" | ")[1] for l in sn - so})}
json.dump(summary, open(os.path.join(R, f"parity-{path}.json"), "w"), indent=2)
print(json.dumps(summary, indent=2))
