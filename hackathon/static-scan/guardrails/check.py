#!/usr/bin/env python3
"""check.py <program> <scan-dev.json> <scan-prod.json>: every finding of the guardrails pack sits on a line marked
`// violates: <policy>[(<stack>)], ...`, and every marker gets its finding, per stack. Findings that aren't on a code
line (package.json, a stack config file, the entry point as a whole) are listed in NON_CODE."""
import json, os, re, sys

PACK = "acme-guardrails"
NON_CODE = {
    ("package.json", 0, "dependency-hygiene", None),
    ("index.ts", 0, "required-stack-outputs", None),
    ("Pulumi.prod.yaml", 0, "cost-estimate", "prod"),
}
MARK = re.compile(r"//\s*violates:\s*(.+)$")


def markers(root):
    out = set(NON_CODE)
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x != "node_modules"]
        for f in files:
            if not f.endswith(".ts"):
                continue
            path = os.path.join(d, f)
            for i, line in enumerate(open(path), 1):
                m = MARK.search(line)
                if not m:
                    continue
                for item in m.group(1).split(","):
                    item = item.strip()
                    mm = re.match(r"([a-z0-9-]+)(?:\((\w+)\))?$", item)
                    out.add((os.path.relpath(path, root), i, mm.group(1), mm.group(2)))
    return out


root = sys.argv[1]
marks = markers(root)
ok = True
for report in sys.argv[2:]:
    stack = "prod" if "prod" in os.path.basename(report) else "dev"
    want = {(f, l, p) for f, l, p, s in marks if s in (None, stack)}
    r = json.load(open(report))
    got = {}
    for x in r["findings"] + r["undecided"]:
        if x["policyPack"] == PACK:
            got.setdefault((x.get("file", ""), x.get("line", 0), x["policy"]), []).append(x)
    missing, extra = want - set(got), set(got) - want
    print(f"{stack}: {len(want)} marked, {len(got)} found (file, line, policy); {len(want & set(got))} match, "
          f"{len(missing)} missing, {len(extra)} unmarked; undecided {len(r['undecided'])}")
    for k in sorted(missing):
        print("  MISSING ", k)
    for k in sorted(extra):
        print("  UNMARKED", k, got[k][0]["message"].split("\n")[-1][:160])
    ok = ok and not missing and not extra
print("OK: every finding is on its marked line" if ok else "MISMATCH")
sys.exit(0 if ok else 1)
