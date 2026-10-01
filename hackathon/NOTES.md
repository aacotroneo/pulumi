# Hackathon notes: pure-function policy packs + in-process goja runtime

Running log. Newest entries at the bottom. Raw data lives in `results/`.

## 2026-09-28 — Setup

- Plan: `~/.claude/plans/i-m-doing-a-hackathon-inherited-glade.md`.
- Branch `hackathon/purejs-policies` (pulumi). Local service at `http://localhost:8080`, org `pulumi_local`.
- Starting point (from exploration):
  - `packs/cis/aws/index.js` is 18.7 MB. rollup `external` misses subpath imports (`@pulumi/aws/rds`, ...), so grpc + node builtins get bundled.
  - `cis-aws` runtime deps: `@pulumi/aws`, `@pulumi/kubernetes`, `@pulumi/policy`, `@pulumi/pulumi` (≈225 MB after `npm install`, per the Notion POC).
  - 7 framework AWS packs emit ~1004 policies, 403 unique names. None async, none use remediation, and none read opts/provider/stackTags.
  - The service treats the pack tarball as an opaque blob. `runtime` is a free-form string, but it's locked per pack name → old packs get published as `old-*`.

## 2026-09-28 — M0: old packs built and published

- Old build times and sizes: `results/old-build.jsonl`. Each `index.js` is 18–20 MB (3.3–3.6 MB gzipped), with a rollup build of 13–17 s per pack.
- `pulumi-best-practices-aws` was built from a HEAD worktree: the policy-packs-internal working tree has an uncommitted WIP edit (`FrameworkConfig: {}` in the PolicyPack args) that fails tsc. The M1 agent also builds from HEAD, so both sides share the same source.
- Published `old-<name>` for all 7 packs to `pulumi_local` (`results/publish-old.jsonl`, 2.4–3.9 s each). The staging script is `scripts/stage-old.sh`, which renames the `PolicyPack("<name>"` literal inside the built bundle.
- Heads-up: `hitrust-aws` (nodejs, 2.6.0 and 2.4.0) already exists in `pulumi_local`, so publishing a purejs `hitrust-aws` may hit the service's runtime lock.
- The dev token `pul-pulumipusdevtoken` was rejected. I logged in with the existing stored localhost credentials (`pulumipus`).

## 2026-09-28 — M2: goja runtime

- Files: `pkg/resource/plugin/analyzer_purejs.go`, `analyzer_purejs_convert.go`, `analyzer_purejs_prelude.js`, `analyzer_purejs_test.go`.
  - Gotcha: any file ending in `_js.go` is a `GOOS=js` build constraint, which is why the files use the `purejs` name.
- Wiring:
  - `NewPolicyAnalyzer` branches on `runtime: purejs`.
  - `installRequiredPolicy` returns right after extracting (no LanguageRuntime, no npm).
  - `InstallPluginDependencies` is a no-op for purejs.
- The pack loads in a background goroutine. The host creates analyzers on a single loader goroutine, so loading inline would serialize every pack.
- The goja features we worried about all work: regex lookbehind (via the regexp2 fallback), accessor-property getters for unknowns (no Proxy), `Buffer`/`atob`/`URL` shims backed by Go, and secret unwrapping. Tests pass under `-race`.
- Go benchmarks (`results/go-bench-purejs.txt`, M-series laptop), on a synthetic bundle with 400 policies:
  - **load** (read + compile + eval + describe): **12.2 ms**, 13 MB alloc;
  - **one resource through all 400 policies**: **1.4 ms**.

## 2026-09-28 — Bench setup

- **Bench stack:** `bench-stack/` is a **Pulumi YAML** program (no npm/tsc for the program itself, so startup noise stays low) with 11 AWS resources: S3 bucket + public-access-block, open SG, IAM role + wildcard inline policy, EC2 instance with secrets in user data, public RDS, SQS, KMS key without rotation, log group.
- **Offline preview:** fake AWS creds + `aws:skip*Validation` flags. The dev-sandbox SSO session had expired, and offline also makes timings deterministic. Preview-only; nothing gets created.
- **Stacks:**
  - `bench-old` → policy group `bench-old` (the 7 `old-*` packs);
  - `bench-new` → policy group `bench-new` (the 7 purejs packs);
  - `bench-local` → no group (for `--policy-pack` runs).
  - New stacks are auto-added to `default-policy-group`, which requires `hitrust-aws@2.6.0` + `super-policy-local`, so `policygroups.py isolate` removes the bench stacks from it.
- **Harness:** `scripts/bench.py`:
  - cold = delete the packs' dirs in `~/.pulumi/policies/pulumi_local` + fresh `npm_config_cache`; warm = rerun.
  - Violations come from `--event-log` `policyEvent`s. That flag is hidden unless `PULUMI_DEBUG_COMMANDS=true`.
  - Both modes use the same dev CLI (`bin/pulumi`, built from this branch).
- **Floor:** preview with no policy packs has a median of **1.52 s** (`results/baseline-no-policies.json`).

## 2026-09-28 — First numbers

- **old / cloud, run 1: cold 99.5 s, warm 11.9 s**, 276 violations. The policy cache after install is **2.16 GB** (7 × npm install of @pulumi/aws + @pulumi/pulumi + @pulumi/policy + @pulumi/kubernetes...).
- **new / local, smoke: 3.2 s wall**, **276 violations** (same count as old).
  - goja load per pack (read + compile + eval + describe) ranges from 20 ms (pbp, 162 KB) to 37 ms (iso-27001, 611 KB, 238 policies).
  - Analyze totals for 12 resources: 1–41 ms per pack.
- **New bundle sizes** (`results/new-bundles.jsonl`): 166–627 KB `policies.js`, 40–120 KB tarballs. Old: 18–20 MB `index.js`, ~3.4 MB gzipped.
- **Publish:**
  - new packs publish in 0.5–0.9 s, against 2.4–3.9 s for old (npm pack plus booting node for GetAnalyzerInfo);
  - the purejs `hitrust-aws` published fine despite the existing nodejs versions (their runtime field was presumably empty, so there was no lock).

## 2026-09-28 — M1 landed + publish bug + full matrix

- **M1 (delegated agent):** worktree `../policy-packs-internal-pure`, branch `hackathon/pure-policies` @ `1aebe335`. Report in `results/m1-bundles.md`.
  - 890 policies; 0 surface diffs vs old bundles; 0 behavior mismatches.
  - 3181/3181 shared specs pass with `@pulumi/policy` swapped for the shim.
  - Stubs are pruned to the members each pack actually reads: 2.4–9 KB per bundle.
  - ~55% of each bundle is string literals (remediation text + framework metadata).
- **CLI bug found:** `archive.TGZ` applies every `.gitignore` from the pack dir up to `/`. Publishing a non-nodejs pack from a gitignored dir (like `dist-pure/` or `hackathon/.build/`) silently uploads an empty tarball (57 bytes). Publish reports success and the failure only shows up at install time.
  - Fix for purejs: `pureJSPackTarball` in `pkg/backend/httpstate/policypack.go` tars exactly `PulumiPolicy.yaml` + main (+ package.json/README if present).
  - The general bug still affects python/other runtimes.
- **Service:** deleting a pack version keeps its version tag reserved, so a republish needs a new tag. The new packs are published as `<version>-purejs`.
- **Parity normalization:** only noise differed: random auto-name suffixes, the `old-` prefix and `-purejs` tag inside "can't run policy" messages, and the stack name in stack-level URNs.
  - After normalizing: **cloud 276/276, local 276/276 identical**.
  - 57 of them are "can't run policy … during preview" advisories, and those match the node SDK text exactly.
- **Results (`results/summary.md`):**

| mode | path | phase | median wall | notes |
|---|---|---|---|---|
| — | — | no policies | 1.52 s | floor |
| old | cloud | cold | **99.5 s** (95–114) | 2.16 GB / 257,898 files in policy cache; 8 node processes |
| old | cloud | warm | 11.6 s | |
| old | local | run | 8.6 s | node_modules pre-installed (symlinked), so this is spawn + load of 18–20 MB bundles |
| new | cloud | cold | **1.47 s** | 2.5 MB / 14 files in cache; 0 extra processes |
| new | cloud | warm | 1.46 s | |
| new | local | run | 1.44 s | |

- **Old cloud cold breakdown** (the -v=9 run):
  - npm install runs 7 packs in parallel for 87.5 s of wall time (per pack 50–87 s);
  - the first GetAnalyzerInfo is at 89.5 s and the first Analyze at 96.5 s.
- **New cloud cold breakdown:**
  - download + extract of all 7 packs: 30 ms;
  - all packs are loaded 0.59 s after process start, including engine and stack startup;
  - per-pack goja load: 11–34 ms. compile is 60–65% of that, and scales with bundle size.
- **Analyze cost:** 1–2 ms total per pack for 12 resources, except hitrust/iso/pci at ~41 ms. Those three are the only packs using the lookbehind regexes in `no-hardcoded-secrets`, which forces goja onto the regexp2 backtracking engine. This is a cheap optimization target: compile the regex once, or rewrite it without lookbehind.

## 2026-09-28 — Demo stack for screen recording

- `demo-stack/` (project `policy-demo`) is deployable: VPC, SG with SSH open to the world, S3, IAM role with a wildcard inline policy, SQS, SNS, log group. It creates in seconds with no RDS/EC2.
  - Stacks: `demo-new` in group `bench-new` (purejs), `demo-old` in group `bench-old` (nodejs).
  - Config: `aws:profile pulumi-dev-sandbox`, `us-west-2`.
- `scripts/demo-wipe.sh` wipes the old and purejs pack dirs from `~/.pulumi/policies/pulumi_local` (2.8 GB → 135 MB; the rest belongs to unrelated packs).
- `bin/pulumi-language-{yaml,nodejs}` are symlinks to the Homebrew ones, so with `bin/` first on PATH the dev CLI doesn't print the "using … from $PATH" warning.
- Offline dry run (fake creds via `--config-file`): cold preview of `demo-new` gives 162 advisory violations.

## 2026-09-28 — Cost: CLI binary size with goja

- `scripts/cli-size.sh` builds `pkg/cmd/pulumi` twice with the `.goreleaser.yml` flags (`-trimpath -tags osusergo,grpcnotrace -ldflags "-w -s"`, CGO off): once from base commit `243d4fa` (a worktree in `.build/cli-size/base-worktree`) and once from the working tree. Results are in `results/cli-size.jsonl`.
- **+6.0–6.3 MB raw (+5.0–5.1%) and +2.0–2.1 MB gzipped (+5.8%)** on darwin/arm64, linux/amd64 and windows/amd64 (for example, darwin/arm64 goes from 117.1 to 123.2 MB).
- The only new modules are goja, `dlclark/regexp2/v2` and `go-sourcemap`. No other dependency versions changed.
- Breakdown (`scripts/cli-size-breakdown.py` → `results/cli-size-breakdown.json`, from `go tool nm -size` on unstripped builds; approximate, since the symbol delta is 6.3 MB against 6.0 MB stripped):
  - goja engine: ~1.74 MB;
  - `golang.org/x/text/collate` + tables: ~1.46 MB. goja imports it unconditionally for `String.prototype.localeCompare`, and no policy uses that. **A goja patch or fork could drop about 1.5 MB (25% of the cost).**
  - Go pclntab: ~1.77 MB, plus type/func metadata ~1.1 MB. This is the runtime's tables for the new code, which stay even in stripped binaries.
  - regexp2/v2: ~0.25 MB;
  - the purejs analyzer + prelude itself: **~32 KB**.
- For comparison, the old path needs node installed (node v22.15.0 on this Mac is a 109 MB binary) and downloads 2.16 GB of node_modules for these 7 packs.

## 2026-09-28 — Handoff to peer (browser runtime + service split/stitch)

- Pushed `policy-packs-internal` branch **`hackathon-purejs-policies`** @ `386d887c` (private repo; the pulumi branch is not pushed). Brief for the peer: `hackathon/BRIEF.md` on that branch.
- A released CLI (v3.252.0) can't run or publish purejs packs: `no analyzer plugin 'pulumi-analyzer-policy-purejs'`. The CLI changes ship as `hackathon/pulumi-cli-purejs.patch` in the packs branch (it applies cleanly on `243d4fa`).
- A bundle can't be split into per-policy code, because policies close over shared helpers in the same file. So the code unit stays the bundle; policies become metadata rows pointing at a bundle.
- Added so that stitching works:
  - bundles append to an existing `__pulumiPolicyPack` header and honor an optional `__pulumiPolicyFilter` hook (`shared/pure/register.ts`);
  - `manifest.json` per pack;
  - `scripts/pure/concat-pack.mjs`.
  - Parity is still 0 surface diffs and 0 behavior mismatches.
- A stitched pack (2 cis + 2 pbp + 1 hand-written mandatory rule, 497 KB) publishes and runs through the patched CLI unchanged. The purejs publish tarball now also includes `manifest.json`. `hackathon-mixed@0.1.0-purejs` is published on the local service.

## 2026-09-28 — Packs branch rebased onto main

- `hackathon-purejs-policies` is now based on `main` @ `05fcbca2` instead of `aa/audit-remainder` (which is `main` + 441 audit commits). It holds 8 commits on top of main, @ `2e6e8e55`, force-pushed with lease over `386d887c`.
- The only conflict was `package.json` scripts; I dropped the audit-only `policy:inventory`/`policy:batches` entries.
- Re-verified on main, rebuilding the old bundles from the same sources:
  - 891 policies (pbp has 55 on main vs 54), 0 surface diffs, 0 behavior mismatches;
  - 3035/3035 specs pass with both the real SDK and the shim;
  - examples type-check, and the stitched pack runs under the patched CLI.
- The benchmark timings in `results/` were measured on the audit-remainder sources and weren't re-run. The policy code differs slightly, but the runtime path is identical.

## 2026-09-28 — Part 2: Input Policies (P0 spike + baseline)

Goal: a single "Input Policy" construct for resources and stacks. It evaluates inputs and uses outputs only as opaque refs (`output-<hash>`) to connect resources, so linking policies work (and can block) during the first preview. Plan: `~/.claude/plans/i-m-doing-a-hackathon-inherited-glade.md`.

- New bench `bench-linked/Pulumi.yaml` (stack `pulumi_local/linked`, 35 resources, all new, fake creds). Every cross-resource link is `${x.id}`/`${x.arn}`. Harness: `scripts/linked.py <label> <packs-dir> [ENV=V]` → `results/linked-<label>.json`.
- **YAML sends per-property dependencies.** From the `PULUMI_POLICY_DUMP_STACK` dump:
  - `goodPab.bucket ← [good]`, `efs.kmsKeyId ← [key]`, `flowLog.vpcId ← [vpc]`, `aclAssociation.resourceArn ← [alb]`;
  - `alb.subnets ← [subnetA, subnetB]` is the ambiguous multi-dependency case;
  - input-echo outputs are known in preview (`membership.user = user-4927ac3`); computed ones are unknown (`id`, `arn`, `keyId`).
- **Baseline, v1 purejs packs, today's semantics:** 141 stack-policy results on the linked bench (7 packs):
  - **70 are advisory "can't be known during preview" (50%)**, 61 pass, 10 violations;
  - resource policies: 16 advisory-unknown, 138 pass, 58 violations.

  Some unknowns come from reading outputs of optional inputs that weren't set (`.acl`, `.replicationConfiguration`, `.internal`). Under the Input view these are simply absent.
- Schema-based output keys: `pulumi-aws/provider/cmd/pulumi-resource-aws/schema.json` gives `properties − inputProperties` = 4665 output-only keys over 1739 AWS types (`Instance`: `arn`, `publicIp`…; `metadataOptions` is an input).
- goja spike: a Proxy spliced between `String.prototype` and `Object.prototype` intercepts `ref.someProp` (it throws), while `typeof`, `===`, Set, JSON, object keys, templates and `trim` keep working on refs and on normal strings.

## 2026-09-28 — Part 2: Input Policies (implemented + measured)

**Construct.** `kind: "input"` with `scope: "resource" | "stack"` (ABI v2). Both scopes run in `AnalyzeStack` against the *input view*:
- props are the program's inputs;
- every output is `output-<sha256(urn)[:16]>`, the producing resource's ref:
  - the resource's own output-only keys (from the pack's `outputKeys`, i.e. schema `properties − inputProperties`);
  - unknown inputs whose `propertyDependencies` point at one resource (one *pending* resource when there are several);
  - known inputs equal to a dependency's output-only value.
- Strings that contain a dependency's output are "derived" (throwing getter).
- Refs support `===`/Set/Map/includes/templates/`trim`. String/RegExp/JSON.parse methods and property reads on a ref throw `OutputAccessError` → advisory "reads the contents of an output". The guards are off outside Input Policies.
- `ctx.isRef/resolve/referrers` are the helpers.
- The engine change is two fields on the internal `AnalyzerStackResource` (`Inputs`, `ID`), filled in `step_generator.AnalyzeResources` and `analyze_snapshot`. No proto, event or state change; gRPC analyzers are unaffected.

**Linked bench** (35 new resources, 7 packs; `results/linked-{v1,input-final}.json`, diff `results/linked-diff-v1-input-final.json`):

| | v1 (today) | Input edition |
|---|---|---|
| advisory "can't be known during preview" | **86** (70 of 141 stack results = 50%, 16 resource) | **8** (only the 6 legacy-kept policies) |
| pass / violation (policy results) | 199 / 68 | 220 / 118 |
| violations reported | 244 | 337 |
| wall (preview) | 3.7 s | 3.5 s |

- Transitions:
  - 50 stack results advisory → violation (17 unique policies: unused EBS volume, orphan SG, subnet without flow logs, single-AZ VPC, misconfigured PAB, buckets without PAB/versioning/SSE/logging/lifecycle/replication/bucket policy, WAF ACL without logging). **All of them are true positives by construction.**
  - 12 stack advisory → pass (e.g. ALB↔WAF association, PAB linked to `good`);
  - 16 resource advisory → pass (EFS/secret CMK, instance-in-VPC now see refs).
  - **0 policies changed targets within the same class.** 7 multi-type resource policies are now NotApplicable (no matching type) instead of "passed".
- **The S3 companion idiom was the only source of false positives** (23 violations on the compliant `good` bucket: versioning/SSE/logging/lifecycle). They were removed by porting 12 files to `shared/utils/links.ts` (`lookupByIdentity`, `outputIdsOf`, `isOutputRef`), where joins also try the bucket's `id`/`arn`. The v1 edition is unchanged: 0 surface diffs, 0 behavior mismatches, 3035/3035 specs with both the SDK and the shim.
- Cost: building the input view takes ~0.5 ms per pack (36 resources, refs=29, ambiguous=2 → `alb.subnets`); 54–234 Input Policies per pack run in 11–20 ms. Legacy `BenchmarkPureJSAnalyze` is unchanged with the guards installed (1.37–1.46 ms/op vs 1.39).
- **Gate:** `pulumi up --yes` with the native examples (`efs-encrypted-with-rotating-cmk`, `s3-bucket-public-access-blocked`, mandatory) fails with `error: preview failed` on `logs` (no PAB) and `barePab` (`blockPublicAcls` off). **0 resources created** (`results/gate-up.log`).
- Regression: the published v1 `-purejs` packs with the new CLI still give 276/276 parity on `bench-stack` (`results/p2/`).

**Output-reliance audit** (`policy-packs-internal-pure/hackathon/input-audit.{json,md}`, `scripts/pure/audit-outputs.mjs`):
- Method: 5096 specs (shared + pack), with every policy's `props` wrapped to record the top-level keys read per type, crossed with the schema's output-only keys (id/arn/urn are allowed as link keys), plus the bench's `OutputAccessError`s.
- 372 unique policies (891 instances): **359 portable (96.5%)** = 304 resource + 55 stack.
  - **6 stack policies rely on outputs** (14 instances): `api-gateway-waf-association` (executionArn), `api-gateway-waf-enabled` (stage.webAclArn), `dynamodb-table-in-backup-plan` (tagsAll), `iam-user-unused-credentials-90` (accessKey.createDate), `rds-private-subnet-validation` (vpc.mainRouteTableId), `secrets-manager-rotation-required` (inspects an ARN).
  - 7 aren't covered by specs.
- **Stack policies: 55/64 portable (86%)**, which matches the "80%+" guess. The 6 go to `scripts/pure/input-exclude.json` and stay legacy in `build-pure.mjs --input` (dist-input).

## 2026-09-28 — Part 2b: output sources (which output an unknown input is)

**Goal.** Keep the state inputs as the view and keep programs unchanged. Known values stay real everywhere, so joins by value work, hardcoded names included. The only change is that each *unknown* input says which output it is, so the same output compares equal wherever the program used it.

**How** (no proto, event, state or engine-phase change):
- **Node SDK** (`output.ts`, `runtime/rpc.ts`, `runtime/resource.ts`):
  - every custom resource output (`id` included) carries a hidden `{resource, property}` tag, kept by `pulumi.output()` and `secret()`;
  - with `PULUMI_POLICY_OUTPUT_SOURCES=1`, `RegisterResource` sends each unknown input as an output value (the existing wire form, previously sent only for remote components) with `source: {urn, property}`, or only `dependencies` when the value is derived (`apply`, `interpolate`, `jsonStringify`).
  - The engine already reads output values for every resource and downgrades them to plain unknowns before goals and providers, so nothing else sees a difference.
- **Engine** (`deploy/output_sources.go`): `RegisterResource` walks the raw request once, before the downgrade, and records `path → source` per URN on the eval source. `AnalyzeResources` attaches it as `AnalyzerStackResource.UnknownInputs`.
- **Analyzer:**
  - an unknown input with a source is `output-<hash(urn)>.<property>`, and the producer's own unknown output-only keys use the same value (`efs.kmsKeyId === key.arn`, `!== key.id`);
  - derived and untraceable unknowns throw as before;
  - known values, the producer's known outputs included, are real, which drops the value-matching and substring heuristics;
  - without sources (YAML, other SDKs) it falls back to the `propertyDependencies` logic, with resource-level refs.
- **Helpers:** `referrers` matches by value only (refs of r, or r's known id/output strings); it no longer uses `propertyDependencies`. Messages show refs as `<output good.id>`.
- **Swallowed errors** (found by the bench): policies wrap `JSON.parse` in `try/catch`, so a guard error became "Invalid JSON in policy document", a false violation. Now, if an Input Policy reads an unknown or an output's contents and catches the error, violations reported after that point are dropped and the result is the advisory.

**Bench:**
- `bench-linked-js` is the same 35 resources as a Node.js program on the local SDK, plus 5: an ENI with two new SGs, an RDS subnet group with two new subnets, and a bucket policy built with `jsonStringify` from `good.arn`. Run with `BENCH=bench-linked-js STACK=pulumi_local/linked-js scripts/linked.py <label> <packs> [PULUMI_POLICY_OUTPUT_SOURCES=1]`.
- Same 35 resources, sources vs fallback vs YAML: **identical** (8 advisory / 220 pass / 118 violation). Every link there is one resource per top-level input, which the fallback already resolved.
- With the 5 extra resources (`results/linked-js3-{unsourced,sourced}.json`):
  - **SG-to-ENI** (`[appSg.id, dbSg.id]`): advisory → violation on `orphanSg` (2 packs). The fallback can't tell the two new SGs apart.
  - **Bucket policy from `good.arn`**: in the fallback it was taken to *be* `good`'s output, and the policies' `try/catch` turned that into 11 wrong verdicts (7 false violations). With the swallow fix those are advisory-output; with sources they are advisory-unknown ("derived from outputs").
- Remaining advisories with sources: those 11 derived documents, plus the 6 legacy-kept policies. Next step for documents: have `jsonStringify`/`interpolate` report their structure, so the known parts (Effect, Principal, Action) can be evaluated and only the leaves are refs.
- YAML bench rerun (`linked-yaml3`) equals `input-final`: the heuristic removal and the swallow fix change nothing there.
- Tests:
  - `TestPureJSInputPolicies` runs both modes, with a swallow case;
  - `TestCollectOutputSources`;
  - Node SDK `output`/`props` specs: 194 passing;
  - langhost `run.spec`: 70/71. `source_position` also fails without these changes.

## 2026-09-28 — Part 2c: simple Input Policies (no helpers, nothing hardcoded)

**Direction (user):** Input Policies link resources by plain equality. A field equals another resource's `id`, name or `arn`. Parsing an output (splitting an ARN, parsing a document built from outputs) is not supported; it stays advisory and is left for Output policies. No per-type or per-field knowledge in the engine.

**Analyzer:**
- Removed:
  - the `ctx.isRef/resolve/referrers` helpers and their value indexes;
  - the output alias table (S3 id = name, ...);
  - the field-name guessing in the fallback;
  - the `ref` field on resources.
- The view is now:
  - real values when known;
  - one opaque value per unknown output (per resource+property with SDK sources, per resource without);
  - guards that flag reads of the contents;
  - a swallowed guard error turns the result into the advisory.

**Policies:**
- The 11 S3 companion policies look the companion up by the bucket's `id` as well as its name, one line each.
- The 3 replication policies compare the destination (written `destination: { bucket: replica.arn }`) with the bucket's `arn` or name, instead of splitting the ARN.
- `shared/utils/links.ts` is gone. The examples are plain `r.props.x === other.props.id || … === other.props.arn`.
- Replication specs: bucket fixtures now carry their `arn` output, as real buckets do.
- Diff: +64/−47 across 11 files, plus specs.

**Results:**
- Specs: 3035/3035 with the SDK and the shim, 0 behavior mismatches; S3 specs 400/400.
- Input edition:
  - YAML bench and Node.js bench with sources: **identical to the helper-based port** (`clean-yaml` = `input-final`, `clean-js-sourced` = `js3-sourced`).
  - Node.js bench without sources: 4 SSL-enforcement results violation → advisory-output. The bucket policy is now found (by id) and its document, built from outputs, can't be read. That's the honest answer, and it matches sources mode.
- **v1 legacy preview cost** (`clean-v1` vs `v1`): 3 results violation → "can't run during preview" (cis/pbp replication, pci ssl). They now read a new bucket's `id` when the name lookup misses, and in legacy previews it's unknown. Existing stacks and `up` are unaffected.

## 2026-09-29 — Part 2d: ABI v2 with one policy shape and explicit outcomes

**Direction (user):** there should be one top-level policy mechanism. It receives every resource plus `ctx`, which has `reportViolation` and `reportPass`. `notApplicable` goes away: not applicable is implicit, and nothing passes or fails by omission. A resource policy names its type and gets `input.resource`; a stack policy names none. Decided with the user: the 7 untyped resource policies get `resourceTypes: ["*"]`, and the shim reports a pass when an existing policy returns cleanly (what `@pulumi/policy` meant).

**The contract (replaces the earlier v2 in place):**
- Policy fields: `{name, ..., resourceTypes?, validate({resource?, resources, config}, {reportViolation, reportPass})}`, with no `kind` or `scope`.
- Per policy:
  - **failed:** any violation or host advisory;
  - **passed:** otherwise, if at least one pass was reported;
  - **not applicable:** nothing was reported, or no resource matched.
- The host maps this onto the engine's existing `Diagnostics`/`NotApplicable`; no engine, proto or event changes. The engine keeps pass/fail per policy only, so pass URNs matter only to the browser host.
- A swallowed guard error now also drops the passes reported after it.

**Changes:**
- **Host (`analyzer_purejs.go`, prelude):**
  - v2 policies without `resourceTypes` run once, with them once per match (`"*"` = all);
  - `kind`/`scope` in v2 is a load error;
  - `run` counts passes;
  - v1 is unchanged.
- **Packs:**
  - the shim's input mode is now a legacy adapter, and the excluded 6 are left out of v2 packs instead of staying v1 stack policies inside them;
  - `define-policy.ts` has a single overloaded `definePolicy`, replacing `definePolicy`/`defineStackPolicy`/`defineInputPolicy`;
  - the 7 examples and `custom-rule.js` use `reportPass`;
  - build and concat validate the v2 shape;
  - new `policy-shim.spec.ts`.
- **`scripts/linked.py`** now reads each pack's `manifest.json`. Policies the engine neither passed nor failed count as `not-applicable`, and v2 kind = resource if it has `resourceTypes`.

**Results:**
- Go: `-run PureJS` passes, with new cases:
  - explicit pass;
  - implicit not applicable (no match, and nothing reported);
  - `"*"`;
  - mixed pass/violation;
  - v2 ctx has no `notApplicable`;
  - swallowed pass dropped;
  - `kind` rejected.
- Lint: 0 issues.
- Packs:
  - shared specs 6288 passing;
  - parity 3035/3035 (SDK and shim), 0 surface diffs, 0 behavior mismatches;
  - native examples: same violations as the legacy policies (13/13). `resource-name-length` now reports nothing for unnamed resources, where the legacy one passed by omission.
- YAML bench (`abi2-yaml` vs `clean-yaml`): **every policy has the same class and targets**. The only change is the 14 rows of the 6 excluded policies (8 advisory-unknown, 6 pass), which are gone. Now 118 violation / 214 pass / 0 advisory, plus 545 not applicable (policy × pack with nothing to check).
- Node.js bench with sources (`abi2-js-sourced` vs `clean-js-sourced`): same, only the 14 excluded rows changed. 150 violation / 220 pass / 11 advisory-unknown (the documents built from `good.arn`).
  - One stack policy (`s3-bucket-ssl-enforcement-required`) stops at the first unknown document, so whether `bare` is reported before it depends on the order the Node program registers resources. It varied between reruns with the same packs (389 vs 393 violations).
- v1 (`abi2-v1` vs `clean-v1`): 0 differences.
- Gate: `up --yes` with the examples fails in preview on `logs`/`barePab`; the stack still has 0 resources (`results/gate-up-abi2.log`).

## 2026-09-29 — Part 2e: separate inputs and outputs (no merged props, no schema)

**Direction (user):**
- Be explicit about what the view does. No merging behind the scenes: each resource has `inputs` and `outputs`, kept apart.
- A resolved value is the real value. An unresolved value that is an output is the identifiable unknown, in both inputs and outputs.
- If inputs are resolved (e.g. resources created inside an `apply` during `up`), just use them.
- SDKs without sources keep the resource-level fallback.
- The shim may merge for legacy policies, since AWS inputs and outputs are compatible.

**Why the old view needed the schema:**
- A first-preview dump (`PULUMI_POLICY_DUMP_STACK`) of the Node.js bench shows the instance with 54 output keys beyond its inputs, all unknown.
- Only 10 are real outputs (arn, publicIp, privateDns, ...). The other 43 are optional inputs the program didn't set, which AWS fills in (associatePublicIpAddress, ebsOptimized, monitoring, ...).
- A merged `props` needed the schema to tell them apart. With `inputs`/`outputs` separate, nothing has to be told apart.

**Changes:**
- **Host:**
  - `R = {type, name, urn, inputs, outputs, parent, dependencies, propertyDependencies}`.
  - `outputs` are the provider's outputs plus `id`; unknowns are `output-<hash(urn)>.<path>`.
  - Removed `outputOnlyKeys`, the `arn` fallback, and `outputKeys` in the pack header.
- **Build:** no more `outputKeys` in bundles. `output-keys.mjs` stays, for the static audit only.
- **Shim adapter (legacy code, explicit and AWS-specific):**
  - resource policies get `props = inputs`;
  - stack policies get inputs plus the `id`/`arn` outputs.
  - A full merge (all outputs under inputs) was tried first. It turned 12 stack results (YAML) from violation into advisory-output: bucket `serverSideEncryptionConfiguration` and `policy`, and instance `securityGroups`, which AWS fills in and are unknown on a first preview. The user chose inputs + id/arn.
- **Native API:** `PolicyResource<TInputs, TOutputs>` with `inputs` and `outputs`; `LinkOutputs` is removed. The examples use `resource.inputs.x` and `other.outputs.id/arn`.

**Results:**
- Go tests pass and lint is clean.
- Shared specs: 6289 passing.
- Parity: 0 behavior mismatches; the native examples match the legacy violations 13/13.
- Benches (`io-yaml`, `io-js-sourced`) are **identical** to `abi2-yaml`/`abi2-js-sourced`: 0 policies changed.
- v1 (`io-v1` vs `clean-v1`): 0 changes.
- Gate: still fails in preview with 0 resources (`results/gate-up-io.log`).

## 2026-09-29 — Part 2f: strict identifiable unknowns (no fallback, identity objects)

**Direction (user):** "apply both, it's OK to be strict". Both address safety issues found by probing the Node SDK with a program that passes outputs through functions, variables, local components (outputs re-exposed and args passed to children), several consumers, `secret`, `output`, `apply`, `interpolate` and `all`.
- **What the probe showed:** identity survives everything that passes the same `Output` along. Everything that computes a new value (`apply`, even `apply(x => x)`; `interpolate`; `all`; `jsonStringify`) becomes a derived unknown.
- **Remote (multi-language) components:** not tested (no awsx here). By code, their outputs come back as new, untagged `Output`s, so they are derived unknowns.

**Changes:**
1. **No resource-level fallback.**
   - An unknown input without an SDK source is always "can't run during preview". It is never a guess from `propertyDependencies`, which could make `x === key.outputs.id` true when the program used `key.arn`, or make a value derived from one resource equal that resource's outputs.
   - `refFor` always includes the property. The `sourced` mode, `pending` and `depsOf` are gone.
2. **Identifiable unknowns are identity objects**, not strings: `__unknown` in the prelude, one frozen Proxy per output.
   - **Allowed:** identity (`===`, `Set`, `Map`, `includes`); `typeof` is "object"; truthy.
   - **Explicit text conversion:** template literals, `String()`, property keys and `JSON.stringify` give the ref string.
   - **Throws `OutputAccessError`:** property reads and method calls, numeric/loose use (`<`, arithmetic, `+`, `==`), `in`, key listing, iteration and assignment.
   - **Still guarded:** string methods, RegExp and `JSON.parse` on the ref string.
   - **Still silent:** only `=== "literal"`.
3. **Legacy code gets ref strings.**
   - The first bench run with objects gave legacy policies **false violations**: S3 companion lookups use `typeof x === "string"`, dropped the object, and reported `good` as unconfigured.
   - So the shim converts unknowns to their ref strings (read under `Symbol.for("pulumi.unknown")`) before legacy code sees them. Deep, cached, and it never reads the throwing getters.
   - Legacy keeps the string guards, but not the `+`/`<`/`==` protection.
   - The native `s3-bucket-versioning` example had the same `typeof` check; it now keys its Map by the raw value.

**Results:**
- Go tests pass, with new cases:
  - `TestPureJSIdentifiableUnknown`: every operation, allowed or throwing;
  - `TestPureJSInputWithoutSources`.
- Lint clean. Shared specs 6290 passing; parity 0 mismatches; v1 unchanged.
- **Node.js with sources** (`strict-js-sourced`): same classes as before. The only difference is the known order-dependent targets of `s3-bucket-ssl-enforcement-required`.
- **YAML, no sources** (`strict-yaml`): 69 results became advisory-unknown (43 violations and 26 passes lost). Now 75 violation / 188 pass / 69 advisory.
- **Gate:**
  - Node.js with sources still blocks (`results/gate-up-strict.log`, 0 resources).
  - The YAML program no longer blocks: its links are advisories (`results/gate-preview-strict-yaml.log`).
  - Other SDKs need to report output sources to link resources at preview.
- **Baseline for the Node.js bench** with today's v1 packs (`js-v1`): 111 advisory-unknown / 199 pass / 92 violation. With sources and strict unknowns: 11 / 220 / 150. The Notion doc's headline numbers now use this program (like for like); the YAML program has no sources yet.

## 2026-09-30 — Idea (not built): probe values for unknown outputs

**Decision (user, 2026-09-30):** keep probing as a fallback only, documented but not built. Output propagation (sources + templates) is good enough. `apply` with a callback is unsupported: its result stays "can't run during preview".

**From the user, for the record:** packs could declare which output fields to "probe": at preview, the unresolved output gets a dummy value that flows through the program. A flag could instead probe `id`/`arn` everywhere, which would catch more edge cases with little effort.
- **What it adds over sources:**
  - Derived values stop being opaque. `interpolate`, `apply`, `all`, `jsonStringify` and remote components would run on the dummy. A bucket policy built from `good.arn` becomes a real document, with the probe token in the `Resource` field.
  - It would cover the 11 derived documents left on the Node.js bench, which is what line 222 asked `jsonStringify`/`interpolate` to report.
  - It needs no SDK change if the engine substitutes the dummy in the `RegisterResource` response. That would work for YAML and every other SDK, not only Node.js.
- **How it stays explicit:**
  - The dummy is the ref string, or embeds it (`output-<hash>.arn`), so the host can still recognize it inside derived strings.
  - The fields come from the pack or from a named flag, not from engine tables.
  - Results that touched a probe say so.
- **Risks to check:**
  - The program sees a known value. Code that branches on it, runs side effects in `apply`, or makes resources inside `apply` behaves differently at preview.
  - Invokes and data sources called with a dummy id would fail (not found).
  - Provider `Check`/`Diff` on dependents may validate the format: an ARN must look like an ARN, and ids like `sg-…` differ by type. Per-type formats would be hardcoding, so this points to generic `id`/`arn` only.
  - Preview display, plans (`--save-plan`) and diffs must never show or keep the dummy. It has to be a preview-only mode, separate from the real preview, or policy-only.
  - It changes preview semantics in the engine. That means escalating before building it for real.
- **Fit with the current design:** it is a complement, not a replacement. Sources give identity for values passed along unchanged; probes give structure for derived values. A derived string with an embedded probe needs its own rule: substring match on the ref, versus the strict "can't run".

## 2026-09-30 — Part 2g: templates (interpolate, concat, jsonStringify)

**Idea:** these functions aren't arbitrary code. The SDK knows how it built the string, so it can say so, and the policy host can rebuild the known parts around the identifiable unknowns. `apply` stays unsupported.

**Changes:**
- **Node SDK** (`output.ts`, `rpc.ts`), behind `PULUMI_POLICY_OUTPUT_SOURCES`:
  - `interpolate`/`concat` tag their result with `{concat: parts}`;
  - `jsonStringify` without a `replacer` tags it with `{json: value}`;
  - `output()`/`secret()` keep the tag;
  - serialization adds `template` to the unknown output value, with each part serialized on its own, so unknown parts carry their own `source` or nested `template`.
- **Engine** (`output_sources.go`): reads `template` into `OutputSource.Template {Kind, Value, Unknowns}`, where `Unknowns` is the parts' sources keyed by path. It's recursive.
- **Host** (convert + prelude):
  - **Joined strings** are their text with each unknown as its ref string: `https://output-….id.s3.amazonaws.com`. A lone unknown with no text around it (`` interpolate`${b.id}` ``) is the identifiable unknown itself.
  - **JSON documents** are their text too. `JSON.parse` on that text gives the document, with each unknown as its identifiable unknown and each joined leaf as its text.
  - **Guarding:** both texts are guarded like ref strings. Comparing them works (`=== \`${b.outputs.arn}/*\``); string methods, RegExp and reads into them throw `OutputAccessError` ("… on 'policy' of … 'bp', built from outputs").
  - **Unsourced parts:** a template with any part lacking a source (for example from `apply`) is "can't run during preview" as a whole.
  - **Messages:** `describeRefs` now matches the longest known ref, so `<output good.id>.s3.amazonaws.com` renders right.
- **Shim:** legacy policies run with `Symbol.for("pulumi.unknownsAsStrings")` set, so parsed documents hold ref strings, as the rest of their view does.

**Results:**
- Go tests pass (`-race`):
  - new `TestPureJSInputTemplates`: document, joined, lone, untraced, read-into, legacy;
  - new `TestCollectOutputTemplates`.
- Lint 0 issues; the SDK's eslint and biome are clean; output specs 194 passing; the shim spec and tsc are clean.
- **Node.js bench with sources** (`tmpl-js-sourced`): 11 → **0** can't run. The 11 bucket-policy results (least privilege, grantee, public read, Macie access) became pass. Nothing else changed: 0 / 231 / 150 (was 11 / 220 / 150), and linked unknowns 40+1 unlinked → 41+0.
- **Negative check** (`BENCH_BAD_POLICY=1`, an `Allow * s3:*` document; `tmpl-js-bad`): 9 of the 11 become violations. The public-read one is reported on bucket `good` itself, since the bucket policy's `bucket: good.id` links it. The 2 Macie-access checks correctly stay pass.

## 2026-09-30 — Headline numbers count distinct policies

**Direction (user):** count policies, not per-pack results. A policy in several packs counts once, and it counts as "can't run" if any of its packs couldn't run it (`wafv2-logging-enabled` and `cloudtrail-s3-bucket-public-access-denied` differ between packs in `js-v1`).

**Node.js bench** (372 distinct policies; only those that apply are shown):
- today (`js-v1`): 39 can't run / 80 pass / 38 violation (157 apply);
- now (`tmpl-js-sourced`): 0 / 89 / 56 (145 apply).

**Where the 39 went:** 18 → violation, 17 → pass, 4 → excluded (among the 6 left for post-deploy policies).

**Why fewer apply:** 6 policies went from pass → not applicable (they only said not applicable), and 2 passing ones are excluded.

**Other runs:**
- bucket-policy templates: 4 policies; with the bad document, 3 fail;
- YAML (`strict-yaml`): 25 / 73 / 29.

The report (v10) and Notion use these numbers.

## 2026-09-30 — Audit: which policies identifiable unknowns improve (no bench data)

**Question (user):** at a policy level, regardless of the bench data, how many policies get better semantics from identifiable unknowns?

**Method:** `scripts/pure/audit-unknowns.mjs` on the packs branch (uncommitted). It uses each policy's own spec tests (5096 pass as written) and runs them three ways, as on the first preview of a stack where every resource is new:
- **as written;**
- **today:** every value that stands for another resource's output throws when read;
- **ABI v2:** those values are identifiable, as the shim gives them to legacy code: ref strings, template text and string guards.

A value "stands for an output" when it is:
- another fixture resource's `id`/`arn`;
- a producer inferred from the key name when the fixture has no id (`bucket` → Bucket, `vpcId` → Vpc; `...Name` keys stay known);
- a literal resource ARN or ID.

**Result, first run (the audit guarded `trim`/`toLowerCase` too, stricter than the host; superseded below)** (372 distinct policies):

| | improved | partly | needs outputs | different verdict | unaffected | not covered |
|---|---|---|---|---|---|---|
| resource | 33 | 3 | 24 | 2 | 243 | 3 |
| stack | 19 | 7 | 7 | 9 | 22 | 0 |
| **total** | **52** | **10** | **31** | **11** | **265** | **3** |

- **Which policies are affected:** 104 policies can't run today once their links point at new resources. With identifiable unknowns, 52 run fully, 10 partly, and 31 still read into an output.
- **The 31:** mostly format checks such as `kmsKeyArn.startsWith("arn:aws:kms:")`, which could become presence checks.
- **Different verdict (11): new findings, preview false violations.**
  - **Join by name, program links by id:** `s3-bucket-notifications-enabled` (prefers `props.bucket`), `iam-user-group-membership-required`, `iam-user-console-access-mfa-enabled`, `cloudtrail-s3-bucket-public-access-denied`, and part of `s3-bucket-replication`.
  - **Config literal vs a new resource's ARN/id** (the `=== "literal"` gap): `vpc-flow-logs` and `vpc-flow-logs-enabled` (approved destinations), and the `ebs-*-unused` exemptions by volume id.
  - **To investigate:** `appsync-waf-association`, `load-balancer-waf-association` (mixed scenarios).

Output: `hackathon/unknowns-audit.{json,md}` on the packs branch.

**Rerun with exactly the host's string guards** (the host doesn't guard `trim`, `toLowerCase`, `trimStart`/`trimEnd`):

| | improved | partly | needs outputs | different verdict | unaffected | not covered |
|---|---|---|---|---|---|---|
| resource | 45 | 2 | 13 | 2 | 243 | 3 |
| stack | 21 | 4 | 5 | 12 | 22 | 0 |
| **total** | **66** | **6** | **18** | **14** | **265** | **3** |

- **Presence checks now run.** 15 policies moved to improved: they check that a value is set with `String(v).trim() !== ""`, and a ref trims to itself.
- **Real reads into a linked value** (13 resource policies):
  - is the key AWS-managed (`/alias\/aws\//.test(kmsKey)`, `indexOf("alias/aws/dynamodb")`);
  - what kind of resource the ARN or id names (`certArn.includes("arn:aws:acm:")`, `eventSourceArn.includes(":kinesis:")`, `gatewayId.startsWith("igw-")`, `arn.split(":")` for SQS vs SNS);
  - is the principal an account root (`p.endsWith(":root")`);
  - `JSON.parse` of a linked policy.
- **Idea:** the "what kind of resource" checks could look the producer up by equality (`resources.find(r => r.outputs.arn === certArn)?.type`), which works at preview. A known ARN of an existing resource still parses.
- **Different verdict (14).** The new ones are exemptions by id: EMR subnets, a Lambda exemption. They're the same class as config literals: without the `toLowerCase` guard, a lowercased ref silently doesn't match.
- **Host gap:** `toLowerCase`/`toLocaleLowerCase` should be guarded like `toUpperCase`. `trim` is harmless on a ref.
