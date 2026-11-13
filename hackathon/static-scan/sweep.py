#!/usr/bin/env python3
"""Lints every Node.js Pulumi project under a directory with `pulumi policy lint`.

  sweep.py <dir> [--stack-pattern production] [-c key=value ...]

Each project uses its first stack file matching the pattern (else its first stack file, else no stack config).
Packs: the 7 ABI v2 packs in $PACKS (default ../policy-packs-internal-pure/dist-input).
"""
import glob, json, os, re, subprocess, sys, time

HACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(HACK)
PULUMI = os.path.join(REPO, "bin", "pulumi")
PACKS_DIR = os.environ.get("PACKS", os.path.join(os.path.dirname(REPO), "policy-packs-internal-pure", "dist-input"))
PACKS = ["cis-aws", "cmmc-aws", "hitrust-aws", "iso-27001-aws", "nist-aws", "pci-dss-aws", "pulumi-best-practices-aws"]

args = sys.argv[1:]
root = os.path.abspath(args.pop(0))
pattern, overrides, fixtures_dir = "production", [], None
while args:
    a = args.pop(0)
    if a == "--stack-pattern":
        pattern = args.pop(0)
    elif a in ("-c", "--config"):
        overrides += ["-c", args.pop(0)]
    elif a == "--fixtures-dir":
        fixtures_dir = os.path.abspath(args.pop(0))

pack_args = sum((["--policy-pack", os.path.join(PACKS_DIR, p)] for p in PACKS), [])
projects = sorted(os.path.dirname(f) for f in glob.glob(os.path.join(root, "**", "Pulumi.yaml"), recursive=True)
                  if "node_modules" not in f)
for d in projects:
    rel = os.path.relpath(d, root)
    if not re.search(r"nodejs", open(os.path.join(d, "Pulumi.yaml")).read()):
        print(f"{rel:45} not nodejs")
        continue
    stacks = sorted(re.sub(r"^Pulumi\.(.*)\.yaml$", r"\1", os.path.basename(f))
                    for f in glob.glob(os.path.join(d, "Pulumi.*.yaml")))
    stack = next((s for s in stacks if pattern in s), stacks[0] if stacks else "lint")
    t0 = time.time()
    fx = []
    if fixtures_dir:
        # <fixtures-dir>/<project path with / as __>.lint.yaml, when present.
        f = os.path.join(fixtures_dir, rel.replace(os.sep, "__") + ".lint.yaml")
        if os.path.exists(f):
            fx = ["--fixtures", f]
    p = subprocess.run([PULUMI, "policy", "lint", d, "--stack", stack, "--json"] + overrides + fx + pack_args,
                       capture_output=True, text=True)
    secs = time.time() - t0
    try:
        r = json.loads(p.stdout)
    except json.JSONDecodeError:
        print(f"{rel:45} {stack:24} FATAL {(p.stderr.strip().splitlines() or ['?'])[-1][:150]}")
        continue
    err = (r.get("errors") or [""])[0].splitlines()[0][:150] if r.get("errors") else ""
    print(f"{rel:45} {stack:24} res={r['resources']:5} findings={len(r['findings']):5} "
          f"undecided={len(r['advisories']):4} {secs:5.1f}s config-made-up={len(r.get('missingConfig') or [])} "
          f"blocked={len(r.get('networkBlocked') or [])} fixtures={len(r.get('usedFixtures') or [])} {err}",
          flush=True)
