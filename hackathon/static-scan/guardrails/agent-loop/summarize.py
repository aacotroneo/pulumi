#!/usr/bin/env python3
"""summarize.py <out dir>: a readable summary (summary.md) of an agent-loop run: each step, each scan's mandatory and
advisory counts, which policies it reported, and the before/after reports."""
import json, os, re, sys

out = sys.argv[1]


def counts(report):
    try:
        r = json.load(open(report))
    except (OSError, json.JSONDecodeError):
        return None
    f = r["findings"]
    return sum(x["enforcementLevel"] == "mandatory" for x in f), sum(x["enforcementLevel"] != "mandatory" for x in f)


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(c.get("text", "") for c in content if isinstance(c, dict))


steps, results, final, scans = [], {}, None, 0
for line in open(os.path.join(out, "transcript.jsonl")):
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        continue
    if ev.get("type") == "assistant":
        for c in ev["message"].get("content", []):
            if c.get("type") == "tool_use":
                steps.append(("tool", c["id"], c["name"], c.get("input", {})))
            elif c.get("type") == "text" and c["text"].strip():
                steps.append(("text", None, None, c["text"].strip()))
    elif ev.get("type") == "user":
        for c in ev["message"].get("content", []) if isinstance(ev["message"].get("content"), list) else []:
            if c.get("type") == "tool_result":
                results[c["tool_use_id"]] = (text_of(c.get("content", "")), c.get("is_error", False))
        for c in ev["message"].get("content", []) if isinstance(ev["message"].get("content"), list) else []:
            if c.get("type") == "text" and "policy scan after this edit" in c.get("text", ""):
                steps.append(("hook", None, None, c["text"].strip()))
    elif ev.get("type") == "result":
        final = ev

lines = ["# Agent loop run", ""]
for label in ("before", "after"):
    row = []
    for s in ("dev", "prod"):
        c = counts(os.path.join(out, f"scan-{label}-{s}.json"))
        row.append(f"{s}: {c[0]} mandatory, {c[1]} advisory" if c else f"{s}: n/a")
    lines.append(f"- **{label}**: " + "; ".join(row))
if final:
    lines.append(f"- turns: {final.get('num_turns')}, duration: {round(final.get('duration_ms', 0) / 1000)} s, "
                 f"cost: ${final.get('total_cost_usd', 0):.2f}, result: {final.get('subtype')}")
lines += ["", "## Steps", ""]
n = 0
for kind, tid, name, body in steps:
    if kind == "hook":
        m = re.search(r"(\d+) mandatory finding", body)
        lines.append(f"- *hook feedback*: {m[1] + ' mandatory finding(s)' if m else body[:200]}")
        continue
    if kind == "text":
        lines.append(f"> {body[:600]}".replace("\n", "\n> "))
        lines.append("")
        continue
    n += 1
    res, err = results.get(tid, ("", False))
    if name == "Bash":
        cmd = body.get("command", "")
        if "policy scan" in cmd:
            # One call may run several scans (`scan dev; scan prod`): pair each report with its --stack.
            stacks = re.findall(r"--stack\s+([\w-]+)", cmd)
            blocks = [b for b in re.split(r"(?=Policy scan of )", res) if b.startswith("Policy scan of ")]
            parts = []
            for i, b in enumerate(blocks):
                scans += 1
                m = re.search(r"(\d+) mandatory, (\d+) advisory", b)
                pols = sorted(set(re.findall(r"acme-guardrails/([a-z0-9-]+)", b)))
                parts.append(f"{stacks[i] if i < len(stacks) else '?'}: "
                             + (f"{m[1]} mandatory, {m[2]} advisory" if m else "no summary")
                             + (f" ({', '.join(pols)})" if pols else ""))
            lines.append(f"{n}. **scan** " + ("; ".join(parts) if parts else f"not run: {res.strip()[:100]}"))
        else:
            lines.append(f"{n}. Bash `{cmd[:120]}`" + (" (denied/error)" if err else ""))
    elif name in ("Edit", "Write", "Read"):
        lines.append(f"{n}. {name} `{os.path.relpath(body.get('file_path', ''), os.path.join(out, 'work'))}`"
                     + (" (error)" if err else ""))
    else:
        lines.append(f"{n}. {name} `{json.dumps(body)[:120]}`")
lines += ["", f"Scans run: {scans}", ""]
if final and final.get("result"):
    lines += ["## Final answer", "", final["result"].strip(), ""]
open(os.path.join(out, "summary.md"), "w").write("\n".join(lines))
print("\n".join(lines))
