#!/usr/bin/env python3
"""Coverage and speed of `pulumi policy lint` on real programs.

  examples.py <examples checkout> [glob ...]     (default globs: aws-ts-* aws-js-*)

The checkout is fetched beforehand, untimed: gh repo clone pulumi/examples -- --depth 1
Each Node.js program is linted twice, without node_modules: once to fill the shared SDK cache (cold) and once warm.
Writes results/lint-examples.json and a markdown table to results/lint-examples.md.
"""
import fnmatch, json, os, re, subprocess, sys, time

HACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(HACK)
PULUMI = os.path.join(REPO, "bin", "pulumi")
PACKS_DIR = os.environ.get("PACKS", os.path.join(os.path.dirname(REPO), "policy-packs-internal-pure", "dist-input"))
PACKS = ["cis-aws", "cmmc-aws", "hitrust-aws", "iso-27001-aws", "nist-aws", "pci-dss-aws", "pulumi-best-practices-aws"]
pack_args = sum((["--policy-pack", os.path.join(PACKS_DIR, p)] for p in PACKS), [])

root = os.path.abspath(sys.argv[1])
globs = sys.argv[2:] or ["aws-ts-*", "aws-js-*"]
progs = sorted(d for d in os.listdir(root)
               if any(fnmatch.fnmatch(d, g) for g in globs)
               and os.path.exists(os.path.join(root, d, "Pulumi.yaml"))
               and re.search(r"nodejs", open(os.path.join(root, d, "Pulumi.yaml")).read()))
env = dict(os.environ, PULUMI_SKIP_UPDATE_CHECK="1")
for k in [k for k in env if k.startswith("AWS_") or k == "PULUMI_ACCESS_TOKEN"]:
    del env[k]


def lint(d):
    t0 = time.time()
    p = subprocess.run([PULUMI, "policy", "lint", os.path.join(root, d), "--json"] + pack_args,
                       env=env, capture_output=True, text=True, timeout=600)
    wall = time.time() - t0
    try:
        r = json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"wall_s": round(wall, 2), "fatal": (p.stderr.strip().splitlines() or ["?"])[-1][:300]}
    return {"wall_s": round(wall, 2), "report": r, "stderr": p.stderr[-2000:]}


rows = []
for d in progs:
    cold = lint(d)
    warm = lint(d)
    row = {"program": d, "cold_s": cold["wall_s"], "warm_s": warm["wall_s"]}
    if "fatal" in warm:
        row.update(status="fatal", error=warm["fatal"])
    else:
        r = warm["report"]
        types = {f["type"] for f in r["findings"]}
        errors = r.get("errors") or []
        row.update(
            status="error" if errors else "ok",
            resources=r["resources"],
            findings=len(r["findings"]),
            mandatory=sum(f["enforcementLevel"] == "mandatory" for f in r["findings"]),
            cant_decide=len(r["advisories"]),
            positioned=sum(1 for f in r["findings"] if f.get("file")),
            stubs=r.get("stubs") or [],
            missing_config=len(r.get("missingConfig") or []),
            error=(errors[0].splitlines()[0][:300] if errors else ""),
            timings=r["timings"],
        )
    rows.append(row)
    print(json.dumps({k: v for k, v in row.items() if k != "timings"}), flush=True)

os.makedirs(os.path.join(HACK, "results"), exist_ok=True)
json.dump(rows, open(os.path.join(HACK, "results", "lint-examples.json"), "w"), indent=1)
with open(os.path.join(HACK, "results", "lint-examples.md"), "w") as f:
    f.write("| program | status | resources | findings | can't decide | stubs | cold s | warm s | error |\n")
    f.write("|---|---|---|---|---|---|---|---|---|\n")
    for r in rows:
        f.write(f"| {r['program']} | {r['status']} | {r.get('resources', '')} | {r.get('findings', '')} | "
                f"{r.get('cant_decide', '')} | {', '.join(r.get('stubs', []))} | {r['cold_s']} | {r['warm_s']} | "
                f"{(r.get('error') or '').replace('|', '/')[:120]} |\n")
ok = [r for r in rows if r["status"] == "ok"]
print(f"\n{len(ok)}/{len(rows)} loaded cleanly; "
      f"warm median {sorted(r['warm_s'] for r in rows)[len(rows) // 2]}s")
