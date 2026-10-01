#!/usr/bin/env python3
"""Compares two linked-bench runs policy by policy: linked-diff.py <labelA> <labelB> → results/linked-diff-<A>-<B>.json"""
import collections, json, os, sys
R = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "results")
a_label, b_label = sys.argv[1], sys.argv[2]
A = {(r["pack"], r["policy"]): r for r in json.load(open(os.path.join(R, f"linked-{a_label}.json")))["policies"]}
B = {(r["pack"], r["policy"]): r for r in json.load(open(os.path.join(R, f"linked-{b_label}.json")))["policies"]}
trans = collections.Counter()
rows = []
for k in sorted(set(A) | set(B)):
    a, b = A.get(k), B.get(k)
    ca = f"{a['kind']}:{a['class']}" if a else "absent"
    cb = b["class"] if b else "absent"
    trans[(ca, cb)] += 1
    ta, tb = set(a["targets"]) if a else set(), set(b["targets"]) if b else set()
    if ca.split(":")[-1] != cb or ta != tb:
        rows.append({"pack": k[0], "policy": k[1], "from": ca, "to": cb,
                     "lost": sorted(ta - tb), "gained": sorted(tb - ta)})
out = {"transitions": {f"{x} -> {y}": n for (x, y), n in sorted(trans.items())}, "changed": rows}
json.dump(out, open(os.path.join(R, f"linked-diff-{a_label}-{b_label}.json"), "w"), indent=1)
print(json.dumps(out["transitions"], indent=1))
