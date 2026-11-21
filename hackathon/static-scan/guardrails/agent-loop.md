# Agent loop: the policy scan as an agent's test

**Setup:**
- A headless Claude Code (`claude -p`, v2.1.327) works on a scratch copy of `program/`, with the clean starting point
  `agent-loop/start/` laid over it. The baseline scan is clean in both stacks.
- It's asked to add an invoices bucket and a Postgres database for the payments team. It's told to run
  `pulumi policy scan . --policy-pack <pack> --stack dev|prod` after each change, until neither stack has mandatory
  findings.
- Flags:
  - `--allowedTools Read Edit Write Glob Grep "Bash(<dev CLI> policy scan*)"`;
  - `--output-format stream-json --verbose`;
  - `--max-turns 60`.
- `agent-loop/run-agent.sh <dir>` does the whole run: the copies, the before scans, the agent, the after scans, the
  diff and `summarize.py`.
- Artifacts are in `agent-loop/runs/<run>/`: `transcript.jsonl`, `agent.diff`, `scan-{before,after}-{dev,prod}.json`
  and `summary.md`.
- **Since run3b**, the working copy holds only `platform/`, the fixtures and the start overlays, not the showcase's
  violation files. `RULES=1` and `HOOK=1` add the generated rules and the hook.

| Run | Start | Request | Scan calls | Steered by a finding | End |
|---|---|---|---|---|---|
| run1 | `start/`: the search team already has a `platform.db.Postgres` | "an S3 bucket for invoices and a Postgres database" | 2 (each scanning dev and prod) | none: it copied the search team's pattern and was clean first time | 0/0 mandatory; 59 s, $0.35 |
| run2 | `start/` + `start-no-db-example/`: no database anywhere in app code | same | 2 | `declared-config`: it read `config.requireSecret("paymentsDbPassword")` without declaring the key | 0/0; 60 s, $0.35 |
| run3 | same as run2 | "an **aws.s3.BucketV2** for invoices and an **aws.rds.Instance** (Postgres 16, db.t3.micro)" | 4 | `use-platform-bucket`, `use-platform-database`, `declared-config`, then `postgres-size-by-stack` (prod) | 0/0; 72 s, $0.44 |
| run3b | run3's setup on the 35-policy pack and the updated platform (control for run4) | same as run3 | 4 | dev: 3 mandatory; prod: 5 (`instance-types-by-stack` and `rds-backups-in-prod` on the raw db.t3.micro too), then `postgres-size-by-stack` (prod) | 0/0; 70 s, $0.45 |
| run4 | run3b + **rules up front** (`agent-rules.md` as CLAUDE.md, `RULES=1`) + **the PostToolUse hook** (`HOOK=1`) | same as run3 | 2 (baseline, final) | none from its own scans. The agent reports one hook message (`declared-config`) between its two edits, before the Pulumi.yaml edit landed. | 0/0; 49 s, $0.39 |

## run3, step by step

The user asked for raw resources, as users often do.

1. It read the project, ran the baseline scans (clean), and wrote what was asked: `new aws.s3.BucketV2(...)`, and
   `new aws.rds.Instance(...)` with `instanceClass: "db.t3.micro"`, `requireSecret` for the password and
   `protect: isProd`.
2. The scan reported 3 mandatory findings in each stack. Each message gave the replacement call, for example:
   > Database 'payments-db' at src/payments/index.ts:17 is a raw Instance. Use the platform component:
   > `new platform.db.Postgres("payments-db", { team: "payments", size: "small", password: config.requireSecret("<key>") }, { provider, protect: pulumi.getStack() === "prod" })` ...

   and for the config key:
   > src/payments/index.ts:27 reads config `acme-shop:paymentsDbPassword`, which Pulumi.yaml doesn't declare. Add it
   > under `config:` in Pulumi.yaml: `paymentsDbPassword: { type: string, description: "<what it is>", secret: true }`.

   The agent said: *"The guardrails require the `@acme/platform` components instead of raw `BucketV2`/`rds.Instance`,
   and want the config key declared. Switching to the platform components."* It rewrote both resources (with
   `dataClass: "confidential"` and `size: "small"`) and declared the key in Pulumi.yaml.
3. Dev was clean; prod reported `postgres-size-by-stack` ("stack "prod" allows "medium" or "large""). The agent
   changed the size to `isProd ? "medium" : "small"`; it did not change the dev stack's rules or the policy.
4. Both stacks were clean.

The final answer told the user that the platform has no `db.t3.micro`, so the request couldn't be met as written,
and that the prod size costs more. It also listed what a human still has to do:
- set `paymentsDbPassword` with `pulumi config set --secret` on both stacks (the scan used a placeholder);
- approve the sizes;
- confirm the data class;
- compile and deploy for real.

The final diff (`runs/run3/agent.diff`) uses `platform.storage.Bucket` and `platform.db.Postgres`. It has:
- kebab-case names;
- the team provider;
- `protect` in prod;
- a secret password from declared config.

## run4 vs run3b: rules up front

Same task as run3, same start, same pack and platform. The only differences are the generated `CLAUDE.md` and the
hook.

| | run3b (no rules) | run4 (rules + hook) |
|---|---|---|
| First edit | raw `aws.s3.BucketV2` + `aws.rds.Instance` (db.t3.micro), as asked | `platform.storage.Bucket` + `platform.db.Postgres`, with `size: isProd ? "medium" : "small"`, `requireSecret`, `protect: isProd` |
| Mandatory findings on its first scan | dev 3, prod 5 | 0 (the hook's one mid-edit `declared-config` aside) |
| Edit-scan rounds to clean | 3 | 1 |
| Turns, time, cost | 14, 70 s, $0.45 | 10, 49 s, $0.39 |
| Final diff | the same components, sizes and config | the same |

**Right the first time.** With the approved choices in its instructions, the agent didn't write the raw resources
the user asked for. It explained up front that the guardrails require the platform components, and that the
platform has no `db.t3.micro`. It also found the deliberate bug in `platform/storage.ts`, where public buckets skip
encryption, and reported it to the platform team without touching it.

**The hook.** It ran in headless `claude -p` from the copy's `.claude/settings.json`. The agent says it got one
message, after its first edit (`src/payments/index.ts` reads `paymentsDbPassword`) and before the second (declaring
it in Pulumi.yaml). That's a transient finding, and it ignored it correctly. Stream-json transcripts don't include
hook output, so this rests on the agent's account. The hook now logs each run to `.claude/scan-hook.log` for later
runs.

## What this shows, and what it doesn't

- **The loop works as a test.** Each scan took about 0.5 s, and the findings pointed at `file:line` with the fix in
  the message. In run3 the agent went from a request for raw resources to golden-path code in three edit-scan
  rounds, without reading the policy pack.
- **Most of the steering came from the codebase when the codebase had the answer.** In run1 the agent copied an
  existing pattern. In runs 1 and 2 it also read the platform's doc comments ("small (dev), medium or large
  (prod)"). The scan mattered when the request or the agent's habits pointed the wrong way: run3, and the
  undeclared config key in run2.
- **The tool restriction was weaker than intended.** `--allowedTools` limited Bash to the scan command, but Claude
  Code still auto-approved read-only commands (`find`, `tail`; `echo` between two scans). Commands with variables or
  `for` loops were refused. Nothing ran beyond reading files in the scratch copy, but a strict sandbox needs
  `--disallowedTools` or a permission mode that denies read-only Bash as well.
- **Rules up front beat rules after the fact on cost.** run4 needed no fix round: about 30% less time and
  13% less cost than run3b, with the same final code. The scan still matters as the check that the rules were
  followed.
- **Five runs, one model, one task.** This is a demonstration, not a measurement.
