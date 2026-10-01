#!/usr/bin/env python3
"""Cold/warm start benchmark for policy packs, old (nodejs) vs new (purejs).

  bench.py <old|new> <cloud|local> [--runs N] [--verbose] [--tag TAG]

cloud: stack bench-<mode>, which Pulumi Cloud (localhost) requires the 7 packs for. Cold = the packs' entries in
       ~/.pulumi/policies/<org> deleted + a fresh npm cache. Warm = the same command again.
local: stack bench-local (no required packs) with --policy-pack for each staged dir in hackathon/.build/<mode>/.
--verbose: one extra run with -v=9 logs, used for phase breakdowns and counting spawned node processes.

Each run writes results/<ts>-<mode>-<path>-<phase>-<n>.json (+ .events.jsonl, .stderr.log).
"""
import argparse, glob, json, os, re, shutil, subprocess, sys, tempfile, time
from datetime import datetime

HACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(HACK)
RESULTS = os.path.join(HACK, "results")
STACK_DIR = os.path.join(HACK, "bench-stack")
ORG = os.environ.get("ORG", "pulumi_local")
PULUMI = os.environ.get("PULUMI", os.path.join(REPO, "bin", "pulumi"))
PACKS = ["cis-aws", "cmmc-aws", "hitrust-aws", "iso-27001-aws", "nist-aws", "pci-dss-aws", "pulumi-best-practices-aws"]
PREFIX = {"old": "old-", "new": os.environ.get("NEW_PREFIX", "")}
POLICY_CACHE = os.path.expanduser(f"~/.pulumi/policies/{ORG}")


def cache_dirs(mode):
    out = []
    for p in PACKS:
        out += glob.glob(os.path.join(POLICY_CACHE, f"pulumi-analyzer-{PREFIX[mode]}{p}-v*"))
    return [d for d in out if os.path.isdir(d)]


def clear_cache(mode):
    for p in PACKS:
        for d in glob.glob(os.path.join(POLICY_CACHE, f"pulumi-analyzer-{PREFIX[mode]}{p}-v*")):
            if os.path.isdir(d):
                shutil.rmtree(d)
            else:
                os.remove(d)


def du(paths):
    total = 0
    for p in paths:
        for root, _, files in os.walk(p):
            for f in files:
                fp = os.path.join(root, f)
                if not os.path.islink(fp):
                    total += os.path.getsize(fp)
    return total


def git_sha():
    return subprocess.run(["git", "-C", REPO, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()


def parse_events(path):
    violations, loads = [], 0
    if not os.path.exists(path):
        return violations, loads
    with open(path) as f:
        for line in f:
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "policyEvent" in ev:
                pe = ev["policyEvent"]
                violations.append({
                    "pack": pe["policyPackName"].removeprefix("old-"),
                    "policy": pe["policyName"],
                    "urn": pe.get("resourceUrn", ""),
                    "level": pe["enforcementLevel"],
                    "message": pe["message"].strip(),
                })
            if "policyLoadEvent" in ev:
                loads += 1
    return violations, loads


TIMING_RE = re.compile(r"\[policy-timing\] (.*)")


def run_once(args, phase, n, ts, verbose=False):
    stack = f"{ORG}/bench-{args.mode}" if args.path == "cloud" else f"{ORG}/bench-local"
    base = f"{ts}-{args.mode}-{args.path}-{phase}-{n}" + (f"-{args.tag}" if args.tag else "")
    events = os.path.join(RESULTS, base + ".events.jsonl")
    stderr_path = os.path.join(RESULTS, base + ".stderr.log")
    cmd = [PULUMI, "preview", "--stack", stack, "--non-interactive", "--diff=false", "--event-log", events]
    if args.path == "local":
        for d in sorted(glob.glob(os.path.join(HACK, ".build", args.mode, "*"))):
            cmd += ["--policy-pack", d]
    if verbose:
        cmd += ["-v=9", "--logflow", "--logtostderr"]
    env = dict(os.environ, PULUMI_POLICY_TIMING="1", PULUMI_SKIP_UPDATE_CHECK="1", PULUMI_DEBUG_COMMANDS="true")
    npm_cache = None
    if phase == "cold":
        npm_cache = tempfile.mkdtemp(prefix="npm-cache-")
        env["npm_config_cache"] = npm_cache
    t0 = time.monotonic()
    with open(stderr_path, "w") as errf:
        p = subprocess.run(cmd, cwd=STACK_DIR, env=env, stdout=subprocess.PIPE, stderr=errf, text=True)
    wall = time.monotonic() - t0
    if npm_cache:
        shutil.rmtree(npm_cache, ignore_errors=True)
    with open(os.path.join(RESULTS, base + ".stdout.log"), "w") as f:
        f.write(p.stdout)

    violations, loads = parse_events(events)
    stderr = open(stderr_path).read()
    timings = TIMING_RE.findall(stderr)
    node_launches = len(re.findall(r"Launching plugin .*(pulumi-language-nodejs|pulumi-analyzer-policy)", stderr)) if verbose else None
    rec = {
        "ts": ts, "mode": args.mode, "path": args.path, "phase": phase, "run": n, "tag": args.tag,
        "verbose": verbose, "wall_s": round(wall, 3), "exit_code": p.returncode,
        "violations": len(violations), "policy_load_events": loads,
        "violations_by_pack": {k: sum(1 for v in violations if v["pack"] == k) for k in sorted({v["pack"] for v in violations})},
        "policy_cache_bytes": du(cache_dirs(args.mode)) if args.path == "cloud" else None,
        "policy_cache_files": sum(len(fs) for d in cache_dirs(args.mode) for _, _, fs in os.walk(d)) if args.path == "cloud" else None,
        "purejs_timings": timings, "node_launches": node_launches, "cli_sha": git_sha(), "cmd": " ".join(cmd),
    }
    with open(os.path.join(RESULTS, base + ".json"), "w") as f:
        json.dump(rec, f, indent=2)
    vpath = os.path.join(RESULTS, f"violations-{args.mode}-{args.path}.json")
    with open(vpath, "w") as f:
        json.dump(sorted(violations, key=lambda v: (v["pack"], v["policy"], v["urn"], v["message"])), f, indent=1)
    print(f"{phase:5} #{n}: wall={wall:6.2f}s exit={p.returncode} violations={len(violations)} "
          f"cache={rec['policy_cache_bytes']}", flush=True)
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["old", "new"])
    ap.add_argument("path", choices=["cloud", "local"])
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--tag", default="")
    args = ap.parse_args()
    ts = datetime.now().strftime("%Y%m%dT%H%M%S")
    print(f"== {args.mode} / {args.path}  cli={PULUMI}")
    recs = []
    for n in range(1, args.runs + 1):
        if args.path == "cloud":
            clear_cache(args.mode)
            recs.append(run_once(args, "cold", n, ts))
            recs.append(run_once(args, "warm", n, ts))
        else:
            recs.append(run_once(args, "run", n, ts))
    if args.verbose:
        if args.path == "cloud":
            clear_cache(args.mode)
            run_once(args, "cold", 0, ts, verbose=True)
        else:
            run_once(args, "run", 0, ts, verbose=True)
    by = {}
    for r in recs:
        by.setdefault(r["phase"], []).append(r["wall_s"])
    print("| mode | path | phase | runs | median wall (s) | min | max |")
    print("|---|---|---|---|---|---|---|")
    for ph, ws in by.items():
        ws = sorted(ws)
        print(f"| {args.mode} | {args.path} | {ph} | {len(ws)} | {ws[len(ws)//2]:.2f} | {ws[0]:.2f} | {ws[-1]:.2f} |")


if __name__ == "__main__":
    main()
