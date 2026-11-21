### Part 3h (2026-11-21): guardrails beyond security, with a scan context (`static-scan/guardrails/`)

**Framing.**
- Each policy turns a decision the agent would otherwise guess at into a test with a right answer.
- A scan only sees what the code declares; quotas, what already exists, and names already taken stay with the
  preview.

The full catalog, with a status per idea, is in [`static-scan/guardrails/README.md`](static-scan/guardrails/README.md).

**Scan context** (branch `hackathon/scan-guardrails`, worktree `../pulumi-scan-guardrails`, from `aa/policy-scan`
4d5b6592f9; local, uncommitted).
- **Where it lives:** stack policies see `props.scan` on the root `pulumi:pulumi:Stack`. That needs no protocol or
  host change, and the scan never runs resource policies on the Stack. It is scan-only: a real preview analyzes the
  Stack.
- **Project:** name, description, and the Pulumi.yaml config schema. Stack config: which keys are `secure:`, plus
  plain values (allowed regions, budgets).
- **Per resource:**
  - file:line;
  - custom, remote and read;
  - provider and version;
  - options: protect, retainOnDelete, ignoreChanges, aliases, deletedWith and the rest;
  - `secretInputs`;
  - `createdInApply`.
- **Per program:**
  - `package.json`, lockfile and files;
  - imports, config reads and side effects, each with file:line;
  - invokes, stack references, stack outputs (name, secret) and `registerPackage` calls;
  - `Date.now`/`Math.random`/`crypto.randomUUID` callers.
- **Findings off a resource:** a policy can report on `<stack urn>#<file>:<line>`, for program-level findings such as
  a config read or an import. The real fix is a location field on the diagnostic.
- **The protocol's own `options`** (protect, ignoreChanges, deleteBeforeReplace) are now filled too. The lean v1
  host doesn't pass them to JavaScript.

**Two scan bugs fixed on the way.**
- **Secrets never reached policies:** `ScanMonitor.getDeploymentInfo` filtered out feature 0, which is `SECRETS`, so
  the SDK serialized every secret as plain text.
- **Resources created in arrow callbacks had no file:line:** the SDK's frame regexp needs `at fn (file:l:c)`. During
  a scan it now also parses anonymous frames. Effect on the examples: 80 findings in `aws-ts-multi-language-lambda`
  moved from the `.map(...)` line to the `new aws.lambda.Function(` line. Nothing else changed.

**Showcase.**
- **Program:** an `acme-shop` workspace, with:
  - `@acme/platform` (Bucket, Postgres, Service, Role, team provider, a deprecated module);
  - `src/payments`, `src/search` and an unowned `lib/`;
  - dev and prod stacks.
- **Pack:** `acme-guardrails`, a hand-written purejs v1 pack of 35 policies. Each message gives the approved choice,
  the reason and the fix, and one `APPROVED` table holds the choices.
- **Policies by group:**
  - **golden paths:** platform bucket, database, approved modules;
  - **components:** usage per stack, implementation invariants, encapsulation by a child's `id`;
  - **naming and determinism:** kebab-case, physical-name prefix, deterministic names;
  - **files and blast radius:** team ownership by path, no resources in the entry point, allowed locations, forbidden
    types, no resources in apply, hermetic programs;
  - **size, retention and cost per stack:** EC2 and RDS families, log retention, RDS backups in prod, a rough cost
    estimate against team budgets (advisory);
  - **network, identity and shared infra:**
    - shared-infra ownership: VPC/NAT/IGW go to the network team, KMS and Route53 to the platform team;
    - public load balancers only through the service component;
    - provider region allowed by stack config;
    - no IAM users;
    - IAM least privilege (no `*`, allowlisted managed policies);
    - permission boundaries;
    - no hardcoded ARNs;
    - security review (advisory);
  - **definition of done:** an alarm and a log group per service or Lambda; the required stack outputs;
  - **best practices:** protect stateful resources in prod, secrets stay secret, declared config, explicit provider
    with default tags, no `ignoreChanges: ["*"]`, dependency hygiene.
- **Result:** `run.sh` gives dev 43 findings (33 mandatory) and prod 47 (36 mandatory), in about 0.5 s each.
  `check.py` matches every finding to its `// violates:` marker by file:line and policy: 43/43 and 47/47, with none
  missing or unmarked.
- **Designed stack differences:**
  - dev only: database size, EC2 family;
  - prod only: protect ×3, RDS backups, log retention, cost over budget.
- **What else, built:**
  - `agent-rules.js` generates a CLAUDE.md section from the pack (`agent-rules.md`);
  - `program/.claude/settings.json` is a `PostToolUse` hook that scans after every edit and returns mandatory findings
    with exit 2;
  - `inventory.sh` + `pack-inventory/` give golden-path adoption. The showcase is at 44%: 22 of 50 cloud resources go
    through components.

**Agent loop** (headless `claude -p`, tools limited to Read/Edit/Write/Glob/Grep and the scan command; see
`static-scan/guardrails/agent-loop.md`).

| Run | Setup | Scan calls | Steered by | Time, cost |
|---|---|---|---|---|
| run1 | a database example in app code | 2 | nothing: it copied the pattern | 59 s, $0.35 |
| run2 | no database example | 2 | `declared-config` | 60 s, $0.35 |
| run3 | user asks for `aws.s3.BucketV2` + `aws.rds.Instance` | 4 | `use-platform-bucket`, `use-platform-database`, `declared-config`, then `postgres-size-by-stack` | 72 s, $0.44 |
| run3b | run3 on the 35-policy pack (control) | 4 | the same; prod also had `instance-types-by-stack` and `rds-backups-in-prod` | 70 s, $0.45 |
| run4 | run3b + generated rules as CLAUDE.md + the hook | 2 (baseline, final) | right the first time; one transient hook message | 49 s, $0.39 |

- **What it showed:**
  - The messages steer: run3 went from raw resources to the platform components in three rounds without reading the
    pack.
  - Rules up front get it right the first time (run4), and the scan confirms they were followed.
  - When the codebase already shows the pattern (run1), the code does most of the steering.
- **Caveats:**
  - Claude Code auto-approves read-only Bash (`find`, `tail`, `echo`) despite `--allowedTools`.
  - Stream-json doesn't record hook output; the hook now logs to `.claude/scan-hook.log`.

**Ideas and statuses** (details in the README).
- **Implemented:** the 35 policies above, plus the rules generator, the hook and the inventory.
- **Ready (the data is in the context, the policy isn't written):**
  - minimum package versions;
  - allowed stack references;
  - config set but never read;
  - sensitive stack outputs must be secret;
  - databases in private subnets;
  - no credentials in provider config.
- **Needs a capability:**
  - remote component internals (the scan would run `Construct`);
  - component outputs (record component `registerResourceOutputs`);
  - hardcoded regions in inputs (needs value provenance);
  - generic sensitive and physical-name fields (needs provider-schema flags);
  - a location field on diagnostics;
  - options and provider in v1 JavaScript;
  - non-Node.js programs.
- **Idea only:** tests and docs next to components.
- **Preview, not scan:** quotas, existing resources and names already taken.

**Regression** (7 published purejs packs, lean host):
- bench: 296 findings, 0 undecided, identical result by result; warm 0.43 s vs 0.42 s;
- 61 examples: 4,747 findings and 123 undecided, unchanged, apart from the position fix above;
- Go tests and golangci-lint: pass;
- SDK `build_package`, mocha 567 + 38 (circular-reference test excluded), eslint and biome: pass.

**How a policy is written (2026-11-21, later).** The pack now shows how policies should be written: they say only
what the rule is, and a small framework at the top of `pack/policies.js` does the rest. It is about 360 lines,
marked "moves into the pack runtime later", and a shim over ABI v1, so it runs on the lean host unchanged.
- **Shapes:** `policy({..., resourceTypes, validate(r, ctx)})` runs once per matching resource, and
  `policy({..., validate(ctx)})` once per program.
- **`r`:** the resource with its scan context (file, line, options, provider, secretInputs, createdInApply).
  Provider inputs come JSON-decoded.
- **`ctx`:**
  - the scan context and `config(key)`;
  - graph helpers: `resources`, `within`, `ancestors`, `children`, `descendants`, `references`/`referencedBy`
    (dependencies, property dependencies and output refs), `providerOf`;
  - `strings`, `parseJSON`;
  - `reportViolation(message, where?)`, where `where` is a resource or anything with `file`/`line`. The framework
    builds the `#file:line` hack.
- **Unknowns:** identifiable unknowns (`output-<hash>.<prop>`), text built from them and plain unknowns become
  interned, opaque Unknown objects, so `===` joins work. Any other use throws inside the framework, which reports
  "can't run policy ... uses `<output x.id>`" as undecided. No policy checks for unknowns any more.
- **Messages:** one or two sentences each (what's wrong, the approved choice, why), with no code and no file:line.
  The full component calls are in `APPROVED` and `agent-rules.md`.
- **Sizes:** the file went from 1,388 to 1,152 lines. The policies went from 1,220 to 733 lines, plus the 360-line
  framework.
- **Result:** the findings are identical (urn, policy, file, line, level, severity), dev 43/43 and prod 47/47, with
  0 undecided.
- **Tested on a scratch program:** an output used as a log retention and as a team tag gives the two expected
  "can't run" results.

