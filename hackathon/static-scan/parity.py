#!/usr/bin/env python3
"""Parity check: `pulumi policy lint` vs a real `pulumi preview` on the same Node.js program.

  parity.py [bench dir] [ENV=VALUE ...]      (default: hackathon/bench-linked-js, stack linked-js)

The preview runs in place (it needs the program's node_modules, the aws plugin and the fake-credential config) against a
throwaway file backend. The lint runs on a copy of the program without node_modules. Both dump what AnalyzeStack sees
(PULUMI_POLICY_DUMP_STACK) and every policy result. Writes results/lint-parity.json and prints a summary.
"""
import collections, json, os, re, shutil, subprocess, sys, tempfile, time

HACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(HACK)
PULUMI = os.path.join(REPO, "bin", "pulumi")
PACKS_DIR = os.environ.get("PACKS", os.path.join(os.path.dirname(REPO), "policy-packs-internal-pure", "dist-input"))
PACKS = ["cis-aws", "cmmc-aws", "hitrust-aws", "iso-27001-aws", "nist-aws", "pci-dss-aws", "pulumi-best-practices-aws"]
STACK = os.environ.get("STACK", "linked-js")

args = [a for a in sys.argv[1:] if "=" not in a]
extra_env = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
bench = os.path.abspath(args[0]) if args else os.path.join(HACK, "bench-linked-js")
work = tempfile.mkdtemp(prefix="lint-parity-")
pack_args = sum((["--policy-pack", os.path.join(PACKS_DIR, p)] for p in PACKS), [])
base_env = dict(os.environ, PULUMI_SKIP_UPDATE_CHECK="1", PULUMI_DEBUG_COMMANDS="true", **extra_env)

# --- preview -------------------------------------------------------------------------------------------------------
state = os.path.join(work, "state")
os.makedirs(state)
penv = dict(base_env, PULUMI_BACKEND_URL="file://" + state, PULUMI_CONFIG_PASSPHRASE="lint",
            PULUMI_POLICY_OUTPUT_SOURCES="1", PULUMI_POLICY_DUMP_STACK=os.path.join(work, "preview-dump.json"))
# `stack init` on a file backend writes an encryption salt into the stack's config file: put the file back after.
stack_file = os.path.join(bench, f"Pulumi.{STACK}.yaml")
saved = open(stack_file).read() if os.path.exists(stack_file) else None
subprocess.run([PULUMI, "stack", "init", STACK, "--non-interactive"], cwd=bench, env=penv, capture_output=True)
events = os.path.join(work, "preview-events.jsonl")
t0 = time.time()
p = subprocess.run([PULUMI, "preview", "--stack", STACK, "--non-interactive", "--diff=false", "--event-log", events]
                   + pack_args, cwd=bench, env=penv, capture_output=True, text=True)
preview_s = time.time() - t0
if saved is not None:
    open(stack_file, "w").write(saved)
if not os.path.exists(events):
    sys.exit("preview failed:\n" + p.stdout[-3000:] + p.stderr[-3000:])

# --- lint ----------------------------------------------------------------------------------------------------------
prog = os.path.join(work, "program")
shutil.copytree(bench, prog, ignore=shutil.ignore_patterns("node_modules", "package-lock.json", ".pulumi"))
lenv = dict(base_env, PULUMI_POLICY_DUMP_STACK=os.path.join(work, "lint-dump.json"))
for k in [k for k in lenv if k.startswith("AWS_") or k == "PULUMI_ACCESS_TOKEN"]:
    del lenv[k]
t0 = time.time()
l = subprocess.run([PULUMI, "policy", "lint", prog, "--stack", STACK, "--json",
                    "--graph-out", os.path.join(work, "lint-graph.json")] + pack_args,
                   env=lenv, capture_output=True, text=True)
lint_s = time.time() - t0
try:
    report = json.loads(l.stdout)
except json.JSONDecodeError:
    sys.exit("lint failed:\n" + l.stdout[-3000:] + l.stderr[-3000:])

# --- compare -------------------------------------------------------------------------------------------------------
def load_dump(f):
    return {r["urn"]: r for r in json.load(open(f))}

pd, ld = load_dump(os.path.join(work, "preview-dump.json")), load_dump(os.path.join(work, "lint-dump.json"))
skip = lambda urn: "::pulumi:providers:" in urn
p_urns = {u for u in pd if not skip(u)}
l_urns = {u for u in ld if not skip(u)}

def norm_unknowns(r):
    return {k: {"urn": v.get("URN"), "property": v.get("Property"), "template": bool(v.get("Template"))}
            for k, v in (r.get("unknownInputs") or {}).items()}

input_diffs, unknown_diffs = [], []
for u in sorted(p_urns & l_urns):
    if u.endswith("::pulumi:pulumi:Stack::" + u.split("::")[-1]) and "pulumi:pulumi:Stack" in u:
        continue
    if pd[u].get("inputs") != ld[u].get("inputs"):
        input_diffs.append({"urn": u, "preview": pd[u].get("inputs"), "lint": ld[u].get("inputs")})
    if norm_unknowns(pd[u]) != norm_unknowns(ld[u]):
        unknown_diffs.append({"urn": u, "preview": norm_unknowns(pd[u]), "lint": norm_unknowns(ld[u])})

def key(pack, policy, urn, level, message):
    return (pack, policy, urn or "", level, message.strip())

pv = collections.Counter()
for line in open(events):
    e = json.loads(line)
    if "policyEvent" in e:
        v = e["policyEvent"]
        pv[key(v["policyPackName"], v["policyName"], v.get("resourceUrn"), v["enforcementLevel"], v["message"])] += 1
lv = collections.Counter()
for f in report["findings"] + report["advisories"]:
    lv[key(f["policyPack"], f["policy"], f["urn"], f["enforcementLevel"], f["message"])] += 1

only_preview = sorted((pv - lv).elements())
only_lint = sorted((lv - pv).elements())
unknown_re = re.compile(r"can't run policy")
summary = {
    "bench": bench, "env": extra_env,
    "preview_s": round(preview_s, 2), "lint_s": round(lint_s, 2), "lint_timings_ms": report["timings"],
    "resources": {"preview": len(p_urns), "lint": len(l_urns),
                  "only_preview": sorted(p_urns - l_urns), "only_lint": sorted(l_urns - p_urns)},
    "input_diffs": len(input_diffs), "unknown_source_diffs": len(unknown_diffs),
    "policy_results": {"preview": sum(pv.values()), "lint": sum(lv.values()),
                       "preview_cant_run": sum(n for k, n in pv.items() if unknown_re.search(k[4])),
                       "lint_cant_run": sum(n for k, n in lv.items() if unknown_re.search(k[4])),
                       "only_preview": len(only_preview), "only_lint": len(only_lint)},
    "stubs": report["stubs"], "errors": report.get("errors"),
}
os.makedirs(os.path.join(HACK, "results"), exist_ok=True)
label = os.environ.get("LABEL", "lint-parity")
json.dump({"summary": summary, "input_diffs": input_diffs, "unknown_diffs": unknown_diffs,
           "only_preview": only_preview, "only_lint": only_lint},
          open(os.path.join(HACK, "results", f"{label}.json"), "w"), indent=1)
print(json.dumps(summary, indent=1))
print("work dir:", work)
