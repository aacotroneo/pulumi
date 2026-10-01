#!/usr/bin/env python3
"""Runs the linked bench (hackathon/bench-linked, stack pulumi_local/linked) with local purejs packs and classifies
every policy result.

  linked.py <label> <packs-dir> [ENV=VALUE ...]

BENCH (default bench-linked) and STACK (default pulumi_local/linked) pick another copy of the bench, e.g.
BENCH=bench-linked-js STACK=pulumi_local/linked-js for the Node.js program.

<packs-dir> holds one directory per pack (e.g. policy-packs-internal-pure/dist-pure). Writes
results/linked-<label>.json with, for each (pack, policy): kind (resource|stack), class
(pass|violation|advisory-unknown|advisory-output|not-applicable) and its violations. The kind and the not-applicable
policies come from each pack's manifest.json: a policy the engine neither passed nor failed was not applicable.
"""
import collections, json, os, re, subprocess, sys, time

HACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(HACK)
R = os.path.join(HACK, "results")
PULUMI = os.path.join(REPO, "bin", "pulumi")
BENCH = os.environ.get("BENCH", "bench-linked")
STACK = os.environ.get("STACK", "pulumi_local/linked")
PACKS = ["cis-aws", "cmmc-aws", "hitrust-aws", "iso-27001-aws", "nist-aws", "pci-dss-aws", "pulumi-best-practices-aws"]

label, packs_dir = sys.argv[1], sys.argv[2]
extra_env = dict(a.split("=", 1) for a in sys.argv[3:])

events = os.path.join(R, f"linked-{label}.events.jsonl")
if os.path.exists(events):
    os.remove(events)
cmd = [PULUMI, "preview", "--stack", STACK, "--non-interactive", "--diff=false", "--event-log", events]
for p in PACKS:
    cmd += ["--policy-pack", os.path.join(packs_dir, p)]
env = dict(os.environ, PULUMI_POLICY_TIMING="1", PULUMI_SKIP_UPDATE_CHECK="1", PULUMI_DEBUG_COMMANDS="true", **extra_env)
t0 = time.time()
proc = subprocess.run(cmd, cwd=os.path.join(HACK, BENCH), env=env, capture_output=True, text=True)
wall = time.time() - t0
open(os.path.join(R, f"linked-{label}.stderr.log"), "w").write(proc.stderr)
open(os.path.join(R, f"linked-{label}.stdout.log"), "w").write(proc.stdout)

UNKNOWN = re.compile(r"can't run policy .* during preview")
OUTPUT = re.compile(r"reads the contents of an output")

def name(urn):
    return re.sub(r"-[0-9a-f]{7}\b", "-<rand>", (urn or "").split("::")[-1])

stack_passed, stack_failed = collections.defaultdict(set), collections.defaultdict(set)
res_policies = collections.defaultdict(set)  # policies that ran per resource (passed or failed at least once)
violations = collections.defaultdict(list)
for line in open(events):
    e = json.loads(line)
    if "policyAnalyzeStackSummaryEvent" in e:
        s = e["policyAnalyzeStackSummaryEvent"]
        stack_passed[s["policyPackName"]] |= set(s.get("passed") or [])
        stack_failed[s["policyPackName"]] |= set(s.get("failed") or [])
    elif "policyAnalyzeSummaryEvent" in e:
        s = e["policyAnalyzeSummaryEvent"]
        res_policies[s["policyPackName"]] |= set(s.get("passed") or []) | set(s.get("failed") or [])
    elif "policyEvent" in e:
        v = e["policyEvent"]
        violations[(v["policyPackName"], v["policyName"])].append(
            {"level": v["enforcementLevel"], "urn": name(v.get("resourceUrn")), "message": v["message"].strip()})

def manifest_kinds(pack):
    """Policy name -> resource|stack. ABI v1 has a kind; in ABI v2 a policy with resourceTypes runs per resource."""
    f = os.path.join(packs_dir, pack, "manifest.json")
    if not os.path.exists(f):
        return {}
    ps = json.load(open(f))["policies"]
    return {p["name"]: p.get("kind") or ("resource" if p.get("resourceTypes") else "stack") for p in ps}

rows = []
for pack in PACKS:
    stack = stack_passed[pack] | stack_failed[pack]
    kinds = manifest_kinds(pack)
    for pol in sorted(set(kinds) - stack - res_policies[pack]):
        rows.append({"pack": pack, "policy": pol, "kind": kinds[pol], "class": "not-applicable", "violations": 0,
                     "mandatory": 0, "unknown": 0, "output": 0, "targets": [], "why": []})
    for pol in sorted(stack | res_policies[pack]):
        vs = violations.get((pack, pol), [])
        kind = kinds.get(pol) or ("stack" if pol in stack else "resource")
        unk = [v for v in vs if UNKNOWN.search(v["message"])]
        out = [v for v in vs if OUTPUT.search(v["message"])]
        real = [v for v in vs if v not in unk and v not in out]
        if real:
            cls = "violation"
        elif out:
            cls = "advisory-output"
        elif unk:
            cls = "advisory-unknown"
        else:
            cls = "pass"
        rows.append({"pack": pack, "policy": pol, "kind": kind, "class": cls,
                     "violations": len(real), "mandatory": sum(v["level"] == "mandatory" for v in real),
                     "unknown": len(unk), "output": len(out),
                     "targets": sorted({v["urn"] for v in real}),
                     "why": sorted({v["message"].split("\n")[-1][:160] for v in unk + out})})

def tally(kind):
    c = collections.Counter(r["class"] for r in rows if kind is None or r["kind"] == kind)
    return dict(sorted(c.items()))

summary = {"label": label, "exit": proc.returncode, "wall_s": round(wall, 2), "env": extra_env,
           "policies": len(rows), "all": tally(None), "stack": tally("stack"), "resource": tally("resource"),
           "violations": sum(r["violations"] for r in rows), "mandatory": sum(r["mandatory"] for r in rows)}
json.dump({"summary": summary, "policies": rows}, open(os.path.join(R, f"linked-{label}.json"), "w"), indent=1)
print(json.dumps(summary, indent=1))
if proc.returncode not in (0, 255):
    print(proc.stderr[-2000:], file=sys.stderr)
