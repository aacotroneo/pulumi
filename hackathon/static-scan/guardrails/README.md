# Guardrails beyond security: policies an agent runs as tests

`pulumi policy scan` runs a program with mocks and checks it against policy packs in about half a second, with no
engine, credentials or stack. That makes policy cheap enough to be a test an agent runs after every edit.

**Each policy turns a decision the agent would otherwise guess at into a test with a right answer:** which component,
which size in this stack, which region, who owns this file, which IAM policies are approved, what "done" means for a
service. The message carries the approved choice, the reason, and the fix.

**A scan only sees what the code declares.** Quotas, what already exists, and names already taken stay with the
preview.

This folder explores which policies make agent-written infrastructure better, beyond the security and compliance
packs, and what the scan had to learn to support them. It covers:
- golden-path components;
- component validation;
- naming;
- code and file conventions;
- size, cost and blast radius;
- Pulumi best practices.

## Contents

- **`program/`**: an `acme-shop` TypeScript workspace.
  - A local platform package, `platform/` (`@acme/platform`), with:
    - the components `acme:storage:Bucket`, `acme:db:Postgres`, `acme:network:Service` and `acme:iam:Role`;
    - the team provider `platform.provider(team)`;
    - a deprecated `legacy` module.
  - Two teams' code, in `src/payments/` and `src/search/`, plus an unowned `lib/`.
  - Stacks `dev` and `prod`, and `PulumiScan.yaml` fixtures.
  - Every policy has a deliberate violation, marked on its line with `// violates: <policy>[(<stack>)]`, and at least
    one compliant use.
  - `.claude/` has a Claude Code `PostToolUse` hook that runs the scan after every edit.
- **`pack/`**: `acme-guardrails`, a hand-written purejs pack (one file, no build) of 35 policies, written on a small
  framework at the top of the file (see "How a policy is written").
  - Each message is one or two sentences: what's wrong, the approved choice, and why. The finding carries the
    file:line.
  - The approved choices (components, sizes, families, regions, managed policies, prices) are one `APPROVED` table;
    the full component calls live there and in `agent-rules.md`, not in messages.
- **`run.sh`**: scans the program as `dev` and `prod` into `results/`. `check.py` then verifies that every finding
  sits on a marked line and every marker gets its finding.
- **`agent-rules.js`**: generates `agent-rules.md` (a CLAUDE.md section) from the pack: the approved choices, and each
  policy with its fix. The rules up front and the checks come from the same file.
- **`pack-inventory/` + `inventory.sh`**: golden-path adoption, from one scan. It reports:
  - the share of cloud resources made through platform components;
  - the components in use, and the platform version;
  - the providers.

  Example output: `results/inventory-dev.json`.
- **`agent-loop.md`**: headless Claude Code runs that add a feature using the scan as their test. The run artifacts
  are in `agent-loop/runs/`.

## Result

```
$ ./run.sh
dev: 43 findings, 33 mandatory, 544 ms
prod: 47 findings, 36 mandatory, 492 ms
dev: 43 marked, 43 found (file, line, policy); 43 match, 0 missing, 0 unmarked; undecided 0
prod: 47 marked, 47 found (file, line, policy); 47 match, 0 missing, 0 unmarked; undecided 0
OK: every finding is on its marked line
```

**Designed dev/prod differences.**

Only in dev:
- `postgres-size-by-stack`: `dbSize: large`;
- `instance-types-by-stack`: an `m6i.large` bastion is prod-only.

Only in prod:
- `protect-stateful-in-prod` (×3);
- `rds-backups-in-prod`;
- `log-retention-by-stack`: 30 days is under prod's 90;
- `cost-estimate`: payments ~$725 against a $600 prod budget.

Three findings have no code line, and `check.py` lists them as such:
- `dependency-hygiene`, on `package.json`;
- `required-stack-outputs`, on `index.ts` as a whole;
- `cost-estimate`, on `Pulumi.prod.yaml`.

## How a policy is written

A policy says only what the rule is. The framework does the rest:
- graph traversal;
- the scan context;
- provider inputs (they come JSON-decoded);
- values only a deployment knows;
- placing findings on lines of code.

```js
policy({ name, description, enforcementLevel, severity, remediationSteps,
         resourceTypes: ["aws:s3/bucket:Bucket", "aws:iam/*", "*"],   // exact types, or prefix globs ending in *
         validate(r, ctx) { ... } });   // once per matching resource, with the whole program in ctx
policy({ name, ..., validate(ctx) { ... } });   // no resourceTypes: once per program
```

**`r`** is the resource:
- `type`, `name`, `urn`, `props`, `parent`, `dependencies` and `propertyDependencies`;
- the scan context's `file`, `line`, `custom`, `read`, `provider`, `version`, `options`, `secretInputs` and
  `createdInApply`.

**`ctx`** is the program:

| Group | Members |
|---|---|
| Scan context | `ctx.stack`; `ctx.project` (`name`, `config`, `stackConfig`); `ctx.program` (`imports`, `configRead`, `sideEffects`, `nondeterminism`, `outputs`, `packageJson`, `localPackages`, ...); `ctx.config(key)` (the stack's value, else Pulumi.yaml's default) |
| Graph | `ctx.resources(type?)`, `ctx.get(urn)`, `ctx.parent(r)`, `ctx.children(r)`, `ctx.descendants(r)`, `ctx.ancestors(r)`, `ctx.within(r, typeOrResource)` (the nearest such ancestor), `ctx.references(r, output?)`, `ctx.referencedBy(r, output?)`, `ctx.providerOf(r)` |
| Values | `ctx.strings(value)` (every known string, with its path), `ctx.parseJSON(text)` |
| Reporting | `ctx.reportViolation(message, where?)`: on `r` by default, or the program for a program policy. `where` may be another resource, or anything with `file` (and `line`): a config read, an import, a side effect, `{ file: "package.json" }`. |

`ctx.references` covers dependencies, property dependencies, and values equal to (or built from) another resource's
output.

Three examples from `pack/policies.js`:

```js
policy({
    name: "use-platform-bucket", resourceTypes: ["aws:s3/bucket:Bucket", "aws:s3/bucketV2:BucketV2"], ...,
    validate(r, ctx) {
        if (!ctx.within(r, "acme:storage:Bucket")) {
            ctx.reportViolation("Use platform.storage.Bucket instead of a raw S3 bucket; it adds encryption, versioning, a public access block and tags.");
        }
    },
});

policy({
    name: "component-encapsulation", resourceTypes: ["*"], ...,
    validate(r, ctx) {
        for (const child of ctx.references(r, "id")) {          // r takes another resource's id
            const comp = ctx.within(child, PLATFORM_COMPONENTS);
            if (comp && !ctx.within(r, comp)) {
                ctx.reportViolation(`This attaches to ${child.name}, inside ${comp.type} ${comp.name}; use the component's API instead of changing its internals.`);
                return;
            }
        }
    },
});

policy({
    name: "declared-config", ...,                                 // no resourceTypes: once per program
    validate(ctx) {
        for (const c of ctx.program.configRead) {
            const d = ctx.project.config[c.key];
            if (c.namespace === ctx.project.name && !(d && d.description)) {
                ctx.reportViolation(`Config ${c.key} is read here but isn't declared in Pulumi.yaml; declare it with a type and a description.`, c);
            }
        }
    },
});
```

**The unknown rule.** A value only a deployment knows is an opaque Unknown object. That covers another resource's
output, which the scan sees as `output-<hash>.<prop>`, text built from one, and a plain unknown.
- The same output is the same object everywhere, so `===` joins between resources work.
- Any other use stops the policy for that resource: string conversion (so a template literal in a message), property
  access, or JSON. The framework then reports "can't run policy 'x' before deployment: 'r' uses
  `<output bucket.id>`, which is unknown until deployment", which the scan lists as undecided.
- Policies never check for unknowns. `typeof v === "string"` guards (for a physical name, a region, an instance
  type, a password) simply don't match an Unknown.
- Comparing an Unknown with a literal (`unknown === "small"`) is false. That's accepted: the message then
  interpolates the value, which throws, and the result is undecided rather than a false violation.

**What moves into the pack runtime later.** The framework is about 360 lines at the top of the file, a shim over ABI
v1: each policy becomes one v1 `kind: "stack"` policy that gets every resource, so it runs on the lean purejs host
unchanged. In a runtime, the pieces become:
- the context merge, provider decoding and Unknown interning: the host's job;
- the graph helpers and `where`: part of the policy SDK;
- the `<stack urn>#file:line` placement: a location field on the diagnostic.

## Catalog

**Status:**
- **implemented**: in `pack/`, firing on the showcase.
- **ready**: the data is in the scan, but the policy isn't written.
- **needs X**: a missing capability.
- **idea**: nothing built.

**Capability:**
- **today**: what policies already see in a scan: type, name, URN, inputs, parent, dependencies,
  propertyDependencies, and identifiable unknowns for outputs.
- **context.\***: the scan context added on branch `hackathon/scan-guardrails` (see below).

### Golden paths and components

| Policy | Why it helps an agent | Capability | Status |
|---|---|---|---|
| `use-platform-bucket`, `use-platform-database`: no raw `aws:s3/bucket` / `aws:rds/instance` outside its platform component | Agents reach for the raw resource they know, or the one the user named. The message names the component, its import and its inputs: one edit. | today (parent chain) | implemented |
| `approved-platform-modules`: no deprecated modules (`@acme/platform/legacy`) or unsupported `acme:*` components; `@acme/platform` ≥ 2 | Deprecations normally live in docs and Slack; agents copy whatever pattern is nearby. | `context.program.imports` (file:line), `localPackages` | implemented |
| Minimum provider and component package versions | Agents pin whatever version they remember. | `context.resources[].version`, `program.packages`, `packageJson` | ready |
| Remote (multi-language) component internals: awsx, eks | Component invariants for the packages people actually use. | needs the scan to run the plugin's `Construct`; today a remote component is one resource with no children | needs capability |

### Validating components

| Policy | Why it helps an agent | Capability | Status |
|---|---|---|---|
| `postgres-size-by-stack` (*usage*): component inputs in sets allowed per stack | Agents pick one value for all stacks. | `context.stack` | implemented |
| `bucket-component-invariants` (*implementation*): every `acme:storage:Bucket` has a public access block, versioning and encryption | Unit tests for component authors, run against every real use. The finding says the bug is in the component, so an agent fixes `platform/storage.ts`, not app code. | today (children by `parent`) | implemented (local components only) |
| `component-encapsulation`: nothing outside a component attaches to its children | The classic shortcut: an SSH rule on a component's internal security group. The message points to the component's `allowFrom` method. | today. A join on a child's `id` (an identifiable unknown). Only `id`: `arn` is often a deliberately exposed output, such as a role's arn passed to a function. | implemented |
| Component outputs registered and documented | Agents read a component's outputs to wire it up. | needs component `registerResourceOutputs` recorded (only the stack's are); that would also let encapsulation tell exposed outputs from internals | needs capability |

### Naming and determinism

| Policy | Why it helps an agent | Capability | Status |
|---|---|---|---|
| `kebab-case-names` | Consistent URNs. The message gives the kebab-case name to use. | today | implemented |
| `physical-name-prefix`: explicit physical names start with `<project>-<stack>-`, or are omitted | Agents hardcode names that collide between stacks. | `context.project.name`, `context.stack` | implemented (field list in the policy; a provider-schema "physical name" flag would make it generic) |
| `deterministic-names`: no `Date.now()`, `Math.random()` or `crypto.randomUUID()` in program code | A name or input built from them differs on every run, so the program never declares the same resources twice. | `context.program.nondeterminism` (call, file:line): the driver wraps the three and records callers in program code | implemented |

### Code, files and blast radius

| Policy | Why it helps an agent | Capability | Status |
|---|---|---|---|
| `team-ownership`: resources in `src/<team>/` carry `team=<team>` | Copy-paste between teams keeps the wrong owner. | `context.resources[].file`, `.provider` | implemented |
| `no-resources-in-entrypoint`: `index.ts` only wires modules | Agents append everything to `index.ts`. | `context.resources[].file` | implemented |
| `allowed-locations`: resources only under `src/<team>/` or `platform/` | Unowned shared code (`lib/`) creates resources nobody owns. | `context.resources[].file` | implemented |
| `forbidden-resource-types`: no `aws:organizations/*`, `aws:account/*` or account-level IAM settings | Bounds what an app stack (and an agent) can touch. | today | implemented |
| `no-resources-in-apply` | A top agent anti-pattern; the scan's probes run the callback, so it's seen even on unknown values. | `context.resources[].createdInApply` | implemented |
| `hermetic-program`: no processes or network at deploy time | Agents shell out to `git` or `curl` for a value. | `context.program.sideEffects` (file:line) | implemented |
| Allowed stack references (approved projects and stacks only) | Agents invent cross-stack dependencies. | `context.program.stackReferences` | ready |
| Tests and docs next to components | Agents skip both. | needs the program's file list beyond loaded modules, or a source AST | idea |

### Size, retention and cost per stack

| Policy | Why it helps an agent | Capability | Status |
|---|---|---|---|
| `instance-types-by-stack`: EC2 families (burstable, up to medium, in dev) and raw RDS classes per stack | Agents copy a prod size into dev, or the other way round. | `context.stack` | implemented |
| `log-retention-by-stack`: `retentionInDays` ≥ 7 in dev, ≥ 90 in prod, and always set | Without it, logs are kept forever (cost) or too briefly (audit). | `context.stack` | implemented |
| `rds-backups-in-prod`: `backupRetentionPeriod` ≥ 7 and `deletionProtection` in prod | Raw RDS defaults are unsafe for prod. Platform components pass; a raw replica doesn't. | `context.stack` | implemented |
| `cost-estimate` (advisory): rough monthly cost per team, from the pack's price table (instance types, DB classes, NAT, LBs), against `teamBudgets` in stack config | A cheap sanity check: "payments declares about $725/month in prod, over its $600 budget". The message gives the total and the top items with file:line. | `context.project.stackConfig[].value`, `.file` for ownership | implemented (list prices only) |

### Network, identity and shared infrastructure

| Policy | Why it helps an agent | Capability | Status |
|---|---|---|---|
| `shared-infra-ownership`: VPCs, subnets, NAT and internet gateways only in `src/network/`; KMS keys and Route53 zones only in `platform/`. Elsewhere, use the owner's stack reference. | Agents build their own VPC "to make it work". The message gives the stack reference to use. | `context.resources[].file` | implemented |
| `public-lb-via-service`: internet-facing load balancers only through `platform.network.Service` | The component adds the security group, target group, logs and defaults. | today (parent chain) | implemented |
| `provider-region-allowed`: an explicit provider's region is in the stack's `allowedRegions` (stack config). This replaces the earlier "region allowlist" row. | Agents pin `us-east-1` or another region. | `context.project.stackConfig[].value` | implemented |
| No hardcoded regions in resource inputs (not provider config) | A region string can't be told from one read from config. | needs value provenance (literal vs config vs output) | needs capability |
| `no-iam-users`: no IAM users, access keys or user policies | Long-lived keys; CI should use an OIDC role. | today | implemented |
| `iam-least-privilege`: no `*` actions or resources in IAM policies; only allowlisted AWS managed policies | `Action: "*"` and `AdministratorAccess` are the agent's shortcut past an AccessDenied. | today (policy JSON in inputs) | implemented. Documents built in `apply` with unknown parts are skipped. |
| `role-permission-boundary`: roles set the boundary; `platform.identity.Role` does it for you | Missing boundaries are a common review finding. | today (parent chain) | implemented |
| `no-hardcoded-arns`: no literal ARNs, account IDs included (AWS managed policy ARNs excepted). This extends `no-hardcoded-account-ids`. | Agents paste example ARNs. | today | implemented |
| `security-review` (advisory): IAM and network resources declared in app code, outside platform components | It tells a human where to look: every IAM and network resource in app code is listed, with file:line. | today | implemented |
| Databases in private subnets | Follows subnet group → subnets → route tables. | today (identifiable unknown joins) | ready |
| No credentials in provider config | Agents paste keys to get past auth errors. | today (provider inputs) | ready |

### Definition of done

| Policy | Why it helps an agent | Capability | Status |
|---|---|---|---|
| `service-definition-of-done`: every `platform.network.Service` and Lambda function has an alarm and a log group with retention that reference it | "Done" becomes a test; the message says which of the two is missing. | today (propertyDependencies and parent links) | implemented |
| `required-stack-outputs`: the stack exports every output in `requiredOutputs` (Pulumi.yaml config) | Other stacks and tools depend on them; the program must export every listed output. | `context.program.outputs`, `project.config[].default` | implemented |

### Pulumi best practices

| Policy | Why it helps an agent | Capability | Status |
|---|---|---|---|
| `protect-stateful-in-prod` | Agents never add resource options unprompted. | `context.resources[].options`, `context.stack` | implemented |
| `secrets-stay-secret`: password-like inputs are secrets; secret config is read with `requireSecret` | The finding points at the read line with the exact method. | `context.resources[].secretInputs`, `program.configRead`, `project.config`, `project.stackConfig` | implemented (field list; the provider schema's `secret: true` would make it generic) |
| `declared-config`: every key read is declared in Pulumi.yaml | The finding points at the read line; the message says to declare it with a type and description. | `context.program.configRead`, `project.config` | implemented |
| `explicit-provider-default-tags` | Agents rely on the default provider and ambient region. | `context.resources[].provider` | implemented |
| `no-ignore-changes-wildcard` | An agent's way to "fix" a perpetual diff. | `context.resources[].options` | implemented |
| `dependency-hygiene`: no `latest`/`*`/git ranges; supported SDK majors | Agents write `"latest"`. | `context.program.packageJson`, `.lockfile` | implemented (ranges; lockfile not enforced) |
| Config set but never read (typos) | Silent misconfiguration. | `project.stackConfig` against `program.configRead` | ready |
| Sensitive stack outputs are secrets | Agents export connection strings. | `context.program.outputs` | ready |

### Needs a preview, not a scan

| Policy | Why it helps an agent | Capability | Status |
|---|---|---|---|
| Quotas, what already exists, names already taken | Out of a scan's reach by design. | the provider and the cloud, at preview | preview only |

### Using the pack around the agent

| Piece | What it does | Status |
|---|---|---|
| Rules up front | `agent-rules.js` generates a CLAUDE.md section from the pack (approved choices, policies, fixes): `agent-rules.md`. | implemented |
| The scan in the agent loop | `program/.claude/settings.json`: a `PostToolUse` hook on Edit/Write runs both scans and returns mandatory findings to the agent (exit 2). It logs each run to `.claude/scan-hook.log`. | implemented. It works in headless `claude -p` (run4), but stream-json transcripts don't record hook output. |
| Inventory | `inventory.sh` + `pack-inventory/`: golden-path share, components and versions, raw resources by type. The showcase is at 44% in dev. | implemented |

### Cross-cutting gaps

- **Positions for program-level findings.** The hack: report on `<stack urn>#<file>:<line>`. The real fix is a
  location field on `AnalyzeDiagnostic` (needs protocol).
- **Options and provider in resource policies.** The protocol has `options` and `provider` on `AnalyzerResource`,
  and the scan fills protect, ignoreChanges and deleteBeforeReplace. The lean v1 host doesn't pass them to
  JavaScript, so every context policy here is a stack policy.
- **Secret-ness in v1.** Secrets are unwrapped, hence `secretInputs`.
- **Other languages.** Node.js programs only.

## The scan context

On branch `hackathon/scan-guardrails` (worktree `../pulumi-scan-guardrails`, based on `aa/policy-scan`), stack
policies see `props.scan` on the root `pulumi:pulumi:Stack` resource:

```
scan.version, scan.stack, scan.codeRoot
scan.project      name, description, runtime, main,
                  config{<ns:key>: {type, description, secret, default, value}}   (Pulumi.yaml)
                  stackConfig{<ns:key>: {secure, value (plain values only)}}       (Pulumi.<stack>.yaml)
scan.resources    {<urn>: {file, line, column, custom, remote, read, id, provider, version,
                           options{protect, retainOnDelete, ignoreChanges, replaceOnChanges, aliases, deletedWith,
                                   deleteBeforeReplace, additionalSecretOutputs, hideDiffs, replaceWith, import,
                                   customTimeouts},
                           secretInputs[<path>], createdInApply}}
scan.program      packageJson{name, version, dependencies, devDependencies}, lockfile, localPackages{<name>: {dir, version}},
                  files[], imports[{module, package, local, file, line}],
                  configRead[{key, namespace, name, method, secret, required, found, file, line}],
                  invokes[], stackReferences[], outputs[{name, secret}], packages[] (registerPackage),
                  sideEffects[{kind, target, file, line}], nondeterminism[{call, file, line, column}],
                  networkBlocked[], stubs[], missingConfig[]
```

**Why the Stack's props:**
- It needs no protocol or host change, and works for any pack runtime.
- The scan never runs resource policies on the Stack, so existing packs only see it in stack policies.
- The regressions are identical (below), so no fallback channel (synthetic resource, hidden key) was needed.

In a real preview the engine does analyze the Stack, so this exact channel is scan-only. It shows the data a future
protocol field would carry.

**What changed, by layer** (all on `hackathon/scan-guardrails`, local, uncommitted):

- **`pkg/cmd/pulumi/policy/scan/scan.js`** (the driver). It records:
  - the request's options, version and package ref;
  - `registerPackage`, and the stack's outputs;
  - imports with file:line;
  - loaded program files;
  - config reads, by wrapping `Config.prototype`;
  - side effects with file:line;
  - calls to `Date.now`/`Math.random`/`crypto.randomUUID` from program code;
  - `package.json` and the lockfile.

  It also fixes a pre-existing bug: `getDeploymentInfo` dropped feature 0 (`SECRETS`), so a scan never serialized
  secrets.
- **`sdk/nodejs`**, gated by `PULUMI_POLICY_SCAN`:
  - `runtime/policyScan.ts`: an `AsyncLocalStorage` apply context, and invoke calls;
  - `output.ts`: runs `apply` callbacks inside that context;
  - `resource.ts`: stamps `createdInApply`, and parses anonymous stack frames so resources created in arrow callbacks
    get a position.
- **`pkg/cmd/pulumi/policy/policy_scan.go` and `policy_scan_context.go`**. They:
  - decode the extra fields;
  - compute `secretInputs`;
  - read the Pulumi.yaml and stack config, including non-secret values;
  - build the context and attach it to the Stack;
  - fill the protocol's own `options`;
  - place `<urn>#file:line` findings.
- **Test:** `TestPolicyScanCmd_Program` checks file:line, options, `secretInputs`, `createdInApply` with its
  position, config reads and side effects.

**Regression** (7 published purejs packs on the lean host, against the same branch before these changes):

| Check | Result |
|---|---|
| Bench | 296 findings, 0 undecided, identical result by result |
| Bench warm wall time (median of 10) | 0.43 s vs 0.42 s before (the driver now also wraps `Date.now`/`Math.random`) |
| 61 pulumi/examples | 4,747 findings and 123 undecided, unchanged. 60 programs are identical result by result. In `aws-ts-multi-language-lambda`, 80 findings moved from `index.ts:20` (the `.map(...)` call) to `index.ts:44` (the `new aws.lambda.Function(` inside the arrow callback): the anonymous-frame fix. |
| Go | `go test ./cmd/pulumi/policy/...` passes; golangci-lint reports 0 issues |
| SDK | `make build_package`; mocha passes, 567 + 38, with the circular-reference test excluded (it crashes on master too); eslint and biome are clean on the changed files |

## Running it

```
./run.sh                                          # both stacks, then check.py
./inventory.sh [program] [stack]                  # golden-path adoption
node agent-rules.js > agent-rules.md              # the rules up front
agent-loop/run-agent.sh <new dir>                 # an agent run; RULES=1 and HOOK=1 add the rules and the hook
```

It needs:
- the dev CLI from `../pulumi-scan-guardrails/bin/pulumi`, with its SDK built (`sdk/nodejs: make build_package`);
- the lean purejs host from `../pulumi-purejs-pr/bin` on `PATH` (the scripts set both up);
- `@pulumi/aws` 7 in the scan's SDK cache (installed on first use).
