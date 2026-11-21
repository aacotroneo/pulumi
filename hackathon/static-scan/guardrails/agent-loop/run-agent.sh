#!/usr/bin/env bash
# The agent-loop demo: a headless Claude Code adds a feature to a copy of the showcase program and uses
# `pulumi policy scan` as its test, until neither stack has mandatory findings.
#
#   run-agent.sh <out dir>     (the out dir must not exist; it gets before/, work/, the transcript and the reports)
#
# The agent may only read and edit files, and run the scan command: --allowedTools has no other Bash.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: run-agent.sh <out dir>}"
G="$HOME/go/src/github.com/pulumi"
CLI="${PULUMI:-$G/pulumi-scan-guardrails/bin/pulumi}"
PACK="$(cd "$HERE/../pack" && pwd)"
MAX_TURNS="${MAX_TURNS:-60}"
export PATH="${PUREJS_HOST_DIR:-$G/pulumi-purejs-pr/bin}:$PATH"
export PULUMI_SKIP_UPDATE_CHECK=1

[ -e "$OUT" ] && { echo "$OUT exists; pick a new directory" >&2; exit 1; }
mkdir -p "$OUT/before" "$OUT/work"
# The platform package and fixtures from the showcase, the app code from start/ (not the showcase's violations).
for d in before work; do
    cp -R "$HERE/../program/platform" "$OUT/$d/platform"
    cp "$HERE/../program/tsconfig.json" "$HERE/../program/PulumiScan.yaml" "$OUT/$d/"
    cp -R "$HERE/start/." "$OUT/$d/"
    # START_EXTRA: another overlay on top, e.g. start-no-db-example (no database in app code to copy).
    if [ -n "${START_EXTRA:-}" ]; then cp -R "$HERE/$START_EXTRA/." "$OUT/$d/"; fi
    # RULES=1: the rules up front, generated from the pack, as the project's CLAUDE.md.
    if [ -n "${RULES:-}" ]; then node "$HERE/../agent-rules.js" "$PACK" > "$OUT/$d/CLAUDE.md"; fi
    # HOOK=1: the PostToolUse hook that scans after every edit (.claude/settings.json).
    if [ -n "${HOOK:-}" ]; then cp -R "$HERE/../program/.claude" "$OUT/$d/.claude"; fi
done
export PULUMI="$CLI" GUARDRAILS_PACK="$PACK"

scan() { # scan <dir> <stack> <out.json>
    "$CLI" policy scan "$1" --policy-pack "$PACK" --stack "$2" --json > "$3" 2> /dev/null
}
for s in dev prod; do scan "$OUT/before" "$s" "$OUT/scan-before-$s.json"; done

SCAN_CMD="$CLI policy scan . --policy-pack $PACK --stack"
TASK="${TASK:-The payments team needs two new things: an S3 bucket for invoices and a Postgres database.}"
PROMPT="This directory is a Pulumi TypeScript program (acme-shop). $TASK Add them to the payments team's code.

Check your work with the policy scan, which runs the program with mocks in about a second:
  $SCAN_CMD dev
  $SCAN_CMD prod
Run both after each change and fix what they report until neither has mandatory findings (advisory ones are OK). \
You can't run other commands (no npm, tsc or pulumi config); you can read and edit files. When you're done, say \
what you changed and what a human still has to do."

cd "$OUT/work"
claude -p "$PROMPT" \
    --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Bash($CLI policy scan*)" \
    --output-format stream-json --verbose \
    --max-turns "$MAX_TURNS" \
    > "$OUT/transcript.jsonl" 2> "$OUT/claude.stderr"
echo "claude exit $?" >> "$OUT/claude.stderr"
cd - > /dev/null

for s in dev prod; do scan "$OUT/work" "$s" "$OUT/scan-after-$s.json"; done
diff -ruN "$OUT/before" "$OUT/work" > "$OUT/agent.diff"
python3 "$HERE/summarize.py" "$OUT"
