#!/usr/bin/env python3
"""Diffs the policyEvents of two --event-log files (Node.js packs vs purejs packs)."""
import json, re, sys, collections
def norm(m):
    m = re.sub(r"-[0-9a-f]{7}\b", "-<rand>", m)
    m = re.sub(r"'old-([a-z0-9-]+)@", r"'\1@", m)
    m = re.sub(r"policy-purejs-poc-(node|purejs)", "policy-purejs-poc-<stack>", m)
    return m.replace("-purejs'", "'").replace("-purejs", "")
def load(p):
    out = []
    for line in open(p):
        try: ev = json.loads(line)
        except Exception: continue
        pe = ev.get("policyEvent")
        if pe:
            out.append(" | ".join([pe["policyPackName"].removeprefix("old-").removesuffix("-purejs"), pe["policyName"], pe["enforcementLevel"],
                                   norm(pe.get("resourceUrn", "").split("::")[-1]), norm(pe["message"].strip())]))
    return collections.Counter(out)
o, n = load(sys.argv[1]), load(sys.argv[2])
print("node:", sum(o.values()), "goja plugin:", sum(n.values()), "identical:", sum((o & n).values()))
for k in (o - n): print("only node:", k[:200])
for k in (n - o): print("only goja:", k[:200])
