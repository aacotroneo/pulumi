#!/usr/bin/env python3
"""Aggregates hackathon/results/* into results/summary.json and results/summary.md."""
import glob, json, os, re, statistics
from datetime import datetime

HACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = os.path.join(HACK, "results")


def jl(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path) if l.strip()]


def runs():
    out = []
    for f in glob.glob(os.path.join(R, "2*.json")):
        r = json.load(open(f))
        if "wall_s" in r:
            r["_file"] = os.path.basename(f)
            out.append(r)
    return out


def breakdown(stderr_path):
    """Phase timings from a -v=9 run (JSON log lines): install spans, analyzer launches, info/analyze milestones."""
    if not os.path.exists(stderr_path):
        return None
    first = last = None
    installs, launches, marks = {}, [], {}
    for line in open(stderr_path, errors="replace"):
        if not line.startswith("{"):
            continue
        try:
            rec = json.loads(line)
            t = datetime.fromisoformat(rec["time"]).timestamp()
        except (ValueError, KeyError):
            continue
        msg = rec.get("msg", "")
        first = first if first is not None else t
        last = t
        m = re.match(r"installPolicyPack\((.+?)\): (beginning install|installation complete)", msg)
        if m:
            installs.setdefault(m.group(1), {})[m.group(2)] = t
        m = re.match(r"newPlugin\(\): Launching plugin '([^']+)'", msg)
        if m:
            launches.append(m.group(1))
        for key, pat in (("first_get_info", r"Analyzer\[.*\]\.GetAnalyzerInfo\(\) executing"),
                         ("first_analyze", r"Analyzer\[.*\]\.Analyze\(|^purejs pack .*: \d+ policies"),
                         ("first_install_begin", r"installPolicyPack\(.*beginning")):
            if key not in marks and re.search(pat, msg):
                marks[key] = t
        if re.match(r"purejs pack .*: \d+ policies", msg):
            marks["last_purejs_loaded"] = t
    rel = lambda k: round(marks[k] - first, 2) if k in marks and first else None
    spans = {k: round(v["installation complete"] - v["beginning install"], 2)
             for k, v in installs.items() if len(v) == 2}
    return {
        "log_span_s": round(last - first, 2) if first else None,
        "install_s_by_pack": spans,
        "install_wall_s": round(max(v.get("installation complete", 0) for v in installs.values()) -
                                min(v.get("beginning install", 1e18) for v in installs.values()), 2) if installs else None,
        "first_install_begin_s": rel("first_install_begin"),
        "first_get_analyzer_info_s": rel("first_get_info"),
        "first_analyze_or_load_s": rel("first_analyze"),
        "last_purejs_loaded_s": rel("last_purejs_loaded"),
        "plugin_launches": launches,
        "policy_processes_spawned": sum(1 for l in launches if l.endswith("(analyzer)") or l == "nodejs"),
    }


def main():
    rs = runs()
    groups = {}
    for r in rs:
        if r.get("verbose") or r.get("tag") == "smoke" or r.get("exit_code") not in (0,):
            continue
        groups.setdefault((r["mode"], r["path"], r["phase"]), []).append(r)
    table = []
    for (mode, path, phase), g in sorted(groups.items()):
        ws = sorted(x["wall_s"] for x in g)
        table.append({
            "mode": mode, "path": path, "phase": phase, "n": len(ws),
            "median_s": round(statistics.median(ws), 2), "min_s": ws[0], "max_s": ws[-1],
            "violations": sorted({x["violations"] for x in g}),
            "policy_cache_bytes": max((x["policy_cache_bytes"] or 0) for x in g) if path == "cloud" else None,
            "policy_cache_files": max((x.get("policy_cache_files") or 0) for x in g) if path == "cloud" else None,
        })
    verbose = {}
    for r in rs:
        if r.get("verbose"):
            b = breakdown(os.path.join(R, r["_file"].replace(".json", ".stderr.log")))
            verbose[f"{r['mode']}-{r['path']}"] = {"wall_s": r["wall_s"], **(b or {}),
                                                   "purejs_timings": r.get("purejs_timings")}
    summary = {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "floor_no_policies": json.load(open(os.path.join(R, "baseline-no-policies.json"))) if os.path.exists(os.path.join(R, "baseline-no-policies.json")) else None,
        "runs": table,
        "verbose_breakdown": verbose,
        "old_build": jl(os.path.join(R, "old-build.jsonl")),
        "new_bundles": jl(os.path.join(R, "new-bundles.jsonl")),
        "publish_old": jl(os.path.join(R, "publish-old.jsonl")),
        "publish_new": jl(os.path.join(R, "publish-new.jsonl")),
        "parity": {p: json.load(open(os.path.join(R, f"parity-{p}.json"))) for p in ("cloud", "local")
                   if os.path.exists(os.path.join(R, f"parity-{p}.json"))},
        "go_bench": open(os.path.join(R, "go-bench-purejs.txt")).read() if os.path.exists(os.path.join(R, "go-bench-purejs.txt")) else None,
        "cli_size": jl(os.path.join(R, "cli-size.jsonl")),
        "cli_size_breakdown": json.load(open(os.path.join(R, "cli-size-breakdown.json"))) if os.path.exists(os.path.join(R, "cli-size-breakdown.json")) else None,
        "m1_bundle_sizes": json.load(open(os.path.join(R, "m1-bundle-sizes.json"))) if os.path.exists(os.path.join(R, "m1-bundle-sizes.json")) else None,
    }
    json.dump(summary, open(os.path.join(R, "summary.json"), "w"), indent=2)

    md = ["# Policy runtime benchmark summary", "", f"Generated {summary['generated']}.", ""]
    if summary["floor_no_policies"]:
        md.append(f"Floor (preview, no policy packs): {summary['floor_no_policies']['median_s']} s median.\n")
    md += ["| mode | path | phase | n | median (s) | min | max | violations | policy cache |", "|---|---|---|---|---|---|---|---|---|"]
    for t in table:
        cache = f"{t['policy_cache_bytes']/1e6:.1f} MB / {t['policy_cache_files']} files" if t["policy_cache_bytes"] is not None else "–"
        md.append(f"| {t['mode']} | {t['path']} | {t['phase']} | {t['n']} | {t['median_s']} | {t['min_s']} | {t['max_s']} | {t['violations']} | {cache} |")
    md += ["", "## Verbose breakdowns", "", "```json", json.dumps(verbose, indent=1), "```"]
    md += ["", "## Parity", "", "```json", json.dumps(summary["parity"], indent=1), "```"]
    if summary["cli_size"]:
        md += ["", "## CLI binary size (release flags, stripped)", "", "| target | base | with goja | delta | base gzip | goja gzip | delta gzip |", "|---|---|---|---|---|---|---|"]
        by = {}
        for r in summary["cli_size"]:
            by.setdefault(f"{r['goos']}/{r['goarch']}", {})[r["variant"]] = r
        for t, v in by.items():
            b, g = v["base"], v["goja"]
            md.append(f"| {t} | {b['bytes']/1e6:.1f} MB | {g['bytes']/1e6:.1f} MB | +{(g['bytes']-b['bytes'])/1e6:.2f} MB (+{100*(g['bytes']-b['bytes'])/b['bytes']:.1f}%) "
                      f"| {b['gzip_bytes']/1e6:.1f} MB | {g['gzip_bytes']/1e6:.1f} MB | +{(g['gzip_bytes']-b['gzip_bytes'])/1e6:.2f} MB (+{100*(g['gzip_bytes']-b['gzip_bytes'])/b['gzip_bytes']:.1f}%) |")
        if summary["cli_size_breakdown"]:
            md += ["", "Where the bytes go (darwin/arm64, unstripped symbol sizes):", ""]
            md += [f"- {v/1e6:.2f} MB — {k}" for k, v in summary["cli_size_breakdown"]["delta_by_group"].items()]
    open(os.path.join(R, "summary.md"), "w").write("\n".join(md) + "\n")
    print("\n".join(md[:20]))


if __name__ == "__main__":
    main()
