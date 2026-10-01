# M1: pure-function JS policy bundles (ABI v1)

All 7 AWS packs build to dependency-free `policies.js` bundles and pass the forbidden-pattern gate. The unmodified policy sources compile through a `@pulumi/policy` shim, and nothing in the policy code was rewritten.

Parity against the legacy rollup bundles:
- **Surface:** 0 diffs.
- **Behavior:** 0 mismatches across 8 hand-built resources, an empty-props sweep over all 111 declared types, and preview-unknown cases.
- **Specs:** all 3181 shared AWS spec tests pass with the shim, the same as with the real SDK.

- **Worktree:** `/Users/alejandrocotroneo/go/src/github.com/pulumi/policy-packs-internal-pure`
- **Branch:** `hackathon/pure-policies`, based on `c7836b99`. Local commits only, nothing pushed.
- **Commit:** `1aebe33520cdcea34466fb4d9394027a9df2b219`. The bundles are byte-identical to `f8ae31fd`, where the full parity run was taken; the last commit only raised the perf iteration count.
- **Size snapshot:** `hackathon/results/m1-bundle-sizes.json`

## Rebuild

```sh
cd /Users/alejandrocotroneo/go/src/github.com/pulumi/policy-packs-internal-pure
npm ci                                   # root workspace; esbuild ^0.25.12 is now an explicit root devDependency
node scripts/build-pure.mjs              # all 7 packs + pure-examples  -> dist-pure/<pack>/{policies.js,PulumiPolicy.yaml}
node scripts/build-pure.mjs cis-aws nist-aws pure-examples     # subset (pack name or dir)
PURE_TARGET=es2019 node scripts/build-pure.mjs                 # lowers ?. and ?? if goja chokes (+~1.4% size)
npx tsc -p shared/pure/tsconfig.json     # type-check shim + definePolicy + examples (strict)

# parity (needs legacy bundles: `npm run build` in each packs/<dir>/aws, ~14 s each)
node scripts/pure-parity.mjs [--skip-specs] [--json out.json]   # also writes dist-pure/parity.md
```

npm aliases: `npm run build:pure` and `npm run pure:parity`. The build takes about 0.15–0.6 s per pack. The first run harvests the `@pulumi/aws` token catalog in about 1.2 s and caches it under `node_modules/.cache/pure-stubs/`.

## Files (all new, except `package.json`, `package-lock.json` (+1 line) and `.gitignore` (`dist-pure/`))

| file | purpose |
|---|---|
| `shared/pure/policy-shim.ts` | `@pulumi/policy` replacement: `validateResourceOfType`, `validateStackResourcesOfType`, `PolicyPack`, `Secret`, `getPulumiType`, and `export type * from "@pulumi/policy"` for typing |
| `scripts/pure/pulumi-stubs-plugin.mjs` | esbuild plugin: `@pulumi/policy` → shim; `@pulumi/{aws,kubernetes,aws-native,azure-native,gcp,azuread}[/*]` → virtual per-namespace modules of `{ __pulumiType }` objects (+ enums); `@pulumi/pulumi[/*]` → empty module; local `.ts` resolved by the plugin (see "Unexpected things") |
| `scripts/pure/check-output.mjs` | forbidden-pattern gate: acorn AST, ES2020 script |
| `scripts/build-pure.mjs` | two-pass esbuild build, surface-equality assertion, gate, and YAML emit |
| `scripts/pure-parity.mjs` | surface, behavior, sweep, unknowns, native examples, specs and perf |
| `shared/pure/define-policy.ts` | native API: `definePolicy`, `defineStackPolicy`, `resourcesOfType`, `definePolicyPack`, `Props<TArgs>` |
| `shared/pure/examples/*.ts`, `shared/pure/tsconfig.json` | 5 native ports and the `pure-examples` pack |

## ABI v1 as implemented

`PulumiPolicy.yaml`. The description comes from the original yaml and is JSON-quoted, which is valid YAML. There is no `name:` key.
```yaml
runtime: purejs
main: policies.js
version: 1.0.2
description: "A policy pack that enforces CIS compliance for AWS."
```

`policies.js` is an esbuild IIFE (`format: iife, platform: neutral, target: es2020, minifySyntax, minifyWhitespace, keepNames, legalComments: none, charset: utf8`). In a bare context, evaluating it sets exactly one global, and `build-pure.mjs` asserts this for every pack:

```js
globalThis.__pulumiPolicyPack = {
  abiVersion: 1, name, version, description,
  // enforcementLevel, displayName, readme, provider, tags, repository, initialConfig: only if set on PolicyPack args (none of the 7 packs set any)
  policies: [{
    name, description, enforcementLevel, severity, framework, remediationSteps,  // + displayName/message/tags/url when present; undefined omitted
    configSchema: { properties, required? },                                       // only when the policy has one
    kind: "resource" | "stack",
    resourceTypes: [...],                                                          // omitted => all types
    validate(input, ctx),
  }],
};
```

The semantics match the spec and the coordinator's clarifications:
- **Resource `validate`.** It rebuilds the legacy args `{type, name, urn, props, opts, stackTags: new Map(), isType, asType, getConfig: () => input.config || {}, notApplicable}`.
- **Resource `resourceTypes`.** This is the deduplicated union of the `__pulumiType` tags on `validateResource`, which can be a function or an array. If any function is untagged, `resourceTypes` is left out.
- **Stack `validate`.** It builds `resources[i]` with `isType`, `asType` and `opts`. It resolves `parent`, `dependencies` and `propertyDependencies` from URNs to the resource objects and drops unknown URNs, the same way `server.ts` does. `resourceTypes` is `[tag]` only when `validateStack` is tagged. None of the 7 packs has a tagged stack policy.
- **`reportViolation(msgOrObject, urn?)`.** It forwards to `ctx.reportViolation` unchanged. Objects pass through, and `urn` is passed only when it is defined.
- **Unknown values.** The shim only catches its own `NotApplicableSignal`, so `UnknownValueError` and every other exception propagate. The parity check verifies this.
- **No reimplementation.** The shim does not re-implement type filtering, enforcement resolution, disabled policies, message formatting or config defaults. There is no `serve()` and no gRPC.

**Deviations and details the Go side should know:**
1. **Single-function resource policies** (the vast majority) call straight through, and `args.notApplicable` maps to `ctx.notApplicable`. If `ctx.notApplicable` ever returns instead of throwing, the shim throws its own sentinel so the policy body still stops, then swallows it.
2. **Multi-function `validateResource` arrays** (4–18 per pack, 4–13 of them spanning more than one type; none mix tagged and untagged functions):
   - Each function is gated on its own tag inside the wrapper.
   - A `notApplicable` from one function does not stop the others.
   - The policy reports NotApplicable only if no function ran to completion.
   - The SDK instead records one not-applicable entry per function. The ABI allows one outcome per call, and violations are identical.
   - An `UnknownValueError` propagates immediately. The SDK records a per-function advisory and continues with the remaining functions, so this is a preview-only difference.
3. **`opts` and `provider`.** `opts` is `input.opts || {}`, and `provider` passes through if the host ever supplies `input.provider` or `resources[i].provider`. The ABI does not define either, so this only adds forward compatibility.
4. **Pack `description`.** It is `args.description`, falling back to the PulumiPolicy.yaml description, which is injected at build time through the esbuild `define` `__PURE_PACK_DESCRIPTION__`. `version` comes from the pack's package.json through `__PURE_PACK_VERSION__`.
5. **Pack-level `displayName`.** This is also passed through (it is in `PolicyPackArgs`).
6. **Output directory for best-practices.** The directory uses the PolicyPack name, so `packs/pulumi-best-practices/aws` goes to `dist-pure/pulumi-best-practices-aws/`, although its package.json name is `aws-best-practices`. The version (1.4.1) still comes from package.json.
7. **Provider stubs** are plain objects `{ __pulumiType: "aws:s3/bucket:Bucket" }`, not classes. Nothing in the 7 packs uses `isInstance` or `instanceof` on provider classes.

## Per-pack results

The node vm timings are medians of 15 runs on a heavily loaded machine (load average 10–18), so treat them only as a rough proxy. "Legacy cold require" means `require(packs/<dir>/index.js)` in a fresh node process with `PolicyPack` stubbed, which includes loading `@pulumi/aws`, `@pulumi/pulumi` and `@pulumi/policy` from node_modules.

| pack | ver | policies (res/stack) | unique resourceTypes | untyped res | untyped stack | policies.js bytes | gzip | legacy index.js bytes | vm compile ms | vm run ms | legacy cold require ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cis-aws | 1.0.2 | 115 (88/27) | 52 | 0 | 27 | 342,520 | 70,177 | 18,870,652 | 2.6 | 0.8 | 513 |
| cmmc-aws | 1.0.2 | 54 (42/12) | 32 | 3 | 12 | 178,401 | 39,553 | 18,667,089 | 1.4 | 0.6 | 718 |
| hitrust-aws | 2.6.4 | 130 (113/17) | 54 | 5 | 17 | 333,852 | 67,001 | 20,214,693 | 3.0 | 1.0 | 656 |
| iso-27001-aws | 1.0.1 | 238 (201/37) | 95 | 4 | 37 | 624,589 | 119,109 | 20,385,970 | 8.3* | 2.2 | 739 |
| nist-aws | 1.0.2 | 139 (109/30) | 56 | 1 | 30 | 411,017 | 84,461 | 19,506,721 | 4.0 | 1.1 | 522 |
| pci-dss-aws | 2.0.4 | 160 (134/26) | 68 | 6 | 26 | 478,991 | 97,685 | 20,472,247 | 3.9 | 1.1 | 570 |
| pulumi-best-practices-aws | 1.4.1 | 54 (44/10) | 30 | 3 | 10 | 164,604 | 36,731 | 18,065,459 | 1.4 | 0.6 | 525 |
| pure-examples (native) | 0.1.0 | 5 (4/1) | 17 | 0 | 1 | 10,920 | 3,662 | – | 0.15 | 0.12 | – |

\* The first-run compile time for iso-27001-aws was 5.2 ms, and the median is inflated by the machine load.

- **Untyped policies.** The two "untyped" columns count policies with no `resourceTypes`, which the host must call for every resource (or every stack). All stack policies are untyped.
- **Where the bytes go.** About 55% of each bundle is string literals: `remediationSteps` (for example 147 KB in iso-27001), framework metadata JSON (78 KB in iso-27001) and messages.
- **Provider stubs.** They take 2.4–9.2 KB per bundle after root-barrel pruning. With namespace-granular stubs only (pass 1), bundles are 177–203 KB larger (for example cis-aws is 534 KB before pruning and 343 KB after). See "Tree-shaking".
- **Legacy bundles** are the rollup `npm run build` output, which still needs `node_modules` at runtime.

### Tree-shaking of provider stubs

Each `@pulumi/aws/<ns>` is its own virtual ES module, so named imports (`import { Instance } from "@pulumi/aws/rds"`) shake to one object. The dominant pattern, `import * as aws from "@pulumi/aws"` followed by `aws.s3.Bucket`, makes esbuild keep the whole `s3` namespace object, because it does not shake nested namespace members. The build therefore runs two passes:

1. **Pass 1** builds with namespace-granular stubs.
2. **The analysis** reads esbuild's canonical output for `pstub_<pkg>_<ns>_exports.<Member>` reads. Any other use of a namespace object marks the whole namespace as used.
3. **Pass 2** makes the root barrel export plain objects holding only those members.

**Safety net:** the build fails if evaluating pass 1 and pass 2 gives a different `JSON.stringify(__pulumiPolicyPack)`, which includes every `resourceTypes` tag. Behavior parity then covers `isType` and `asType` reads inside stack policy bodies. In the current packs, no namespace fell back to whole-namespace use.

## Parity

### a. Surface (legacy `packs/<dir>/aws/index.js` captured with `PolicyPack` stubbed, vs pure bundle in a bare `vm.createContext`)

Compared per policy:
- name and kind
- enforcementLevel and severity
- the full `configSchema` JSON
- description, displayName, message, remediationSteps, url, tags and framework
- the legacy `__pulumiType` tags vs `resourceTypes`

| pack | legacy policies | pure policies | diffs |
|---|---|---|---|
| cis-aws | 115 | 115 | none |
| cmmc-aws | 54 | 54 | none |
| hitrust-aws | 130 | 130 | none |
| iso-27001-aws | 238 | 238 | none |
| nist-aws | 139 | 139 | none |
| pci-dss-aws | 160 | 160 | none |
| pulumi-best-practices-aws | 54 | 54 | none |

### b. Behavior

The legacy policy objects were run through a harness that mirrors `@pulumi/policy` `server.ts`:
- the single-function type fast path
- one try block per array function
- `isType`/`asType` resolved through `__pulumiType`
- the same fast path for stack policies, plus URN resolution

The pure side ran `policy.validate(input, ctx)` from the bundle in a bare vm context with a prelude of `console`, `Buffer`, `atob`, `btoa` and `URL`. It filtered by `resourceTypes`, applied `configSchema` defaults, and created props inside the vm realm. Outcomes were compared exactly: the ordered violation messages and URNs, not-applicable vs pass, and errors.

The 8 resources are:
- S3 bucket without versioning
- EC2 instance without IMDSv2 and with a public IP
- security group with 22/tcp open to 0.0.0.0/0
- IAM role with a `*`/`*` inline policy
- IAM policy with `*`/`*`
- unencrypted, public RDS instance with a literal password
- KMS key with rotation off
- Lambda on nodejs16.x with a secret in its env

Stack policies ran once over all 8 resources.

| pack | resource-policy runs applicable (pure/legacy) | resource violations (pure/legacy) | stack policies applicable | stack violations | mismatches |
|---|---|---|---|---|---|
| cis-aws | 27/27 | 23/23 | 27/27 | 11/11 | 0 |
| cmmc-aws | 44/44 | 31/31 | 12/12 | 4/4 | 0 |
| hitrust-aws | 75/75 | 41/41 | 17/17 | 8/8 | 0 |
| iso-27001-aws | 73/73 | 39/39 | 37/37 | 14/14 | 0 |
| nist-aws | 44/44 | 29/29 | 30/30 | 14/14 | 0 |
| pci-dss-aws | 80/80 | 37/37 | 26/26 | 11/11 | 0 |
| pulumi-best-practices-aws | 45/45 | 33/33 | 10/10 | 8/8 | 0 |

The per-resource breakdown is in `dist-pure/parity.md` in the worktree.

**b2. Sweep.** Every one of the 111 distinct types that any policy declares got empty props, run through every resource policy that applies to it. Three preview-unknown inputs were added, where the host-style getter throws `Error{name:"UnknownValueError"}`: EC2 `metadataOptions`, RDS `storageEncrypted`/`kmsKeyId` and S3 `bucket`. Stack policies ran over the 8 resources plus the 3 unknown resources.

| pack | inputs | policy runs | violations (pure/legacy) | UnknownValueError propagated (pure/legacy) | mismatches |
|---|---|---|---|---|---|
| cis-aws | 111 | 141 | 96/96 | 2/2 | 0 |
| cmmc-aws | 111 | 401 | 83/83 | 1/1 | 0 |
| hitrust-aws | 111 | 712 | 134/134 | 2/2 | 0 |
| iso-27001-aws | 111 | 725 | 189/189 | 3/3 | 0 |
| nist-aws | 111 | 285 | 105/105 | 2/2 | 0 |
| pci-dss-aws | 111 | 846 | 153/153 | 2/2 | 0 |
| pulumi-best-practices-aws | 111 | 402 | 90/90 | 2/2 | 0 |

**Total behavior mismatches: 0.** No shim fixes were needed after the first parity run. The only build fixes were the CommonJS and empty-namespace items under "Unexpected things".

### c. Spec tests

The command was `mocha --require ts-node/register` (with `TS_NODE_TRANSPILE_ONLY`) over `shared/policies/aws/**/*.spec.ts`. The shim variant adds a `Module._resolveFilename` hook that maps `@pulumi/policy` to `shared/pure/policy-shim.ts`. A separate check confirmed that the shim module is in `require.cache` and the real `@pulumi/policy/policy.js` is not.

- **Real `@pulumi/policy`:** 3181 passing, 0 failing.
- **Shim:** 3181 passing, 0 failing.
- **Failing only in one of the two runs:** 0.

These specs exercise the shim's `validateResourceOfType` and `validateStackResourcesOfType` with the specs' own args. The ABI `validate` wrapper is covered by (a) and (b).

### Native `definePolicy` examples (`dist-pure/pure-examples`, 10.9 KB)

Each native policy was compared with the shimmed legacy policy of the same name on 13 inputs (the 8 above plus 5 targeted ones).

| example | compared against | same violations | same applicability |
|---|---|---|---|
| ec2-imdsv2-required | cis-aws | 13/13 | 13/13 |
| security-group-ssh-rdp (3 types, one function) | hitrust-aws | 13/13 | 13/13 |
| rds-instance-disallow-unencrypted-storage | cmmc-aws | 13/13 | 13/13 |
| resource-name-length | pulumi-best-practices-aws | 13/13 | 6/13 (intended) |
| s3-bucket-versioning (stack, via `defineStackPolicy`) | hitrust-aws | 1/1 | 1/1 |

The native `resource-name-length` declares its 13 token types as `resourceTypes`. For every other type the host now skips it as not applicable, where the untyped legacy policy returned "pass".

The examples use `import type * as aws from "@pulumi/aws"`, for example `definePolicy<aws.ec2.InstanceArgs, Config>`, with `Props<T> = Unwrap<NonNullable<T>>`. They type-check with `tsc --strict` (`shared/pure/tsconfig.json`) and reuse the shared utils (`exemption-matching`, `list-normalization`, `value-guards`) unchanged. `tsc` caught two real typing mistakes during the port.

## Prelude globals actually used

This is taken from the AST free-identifier analysis in the gate.

| bundle | prelude globals | exact usage |
|---|---|---|
| cis-aws | `URL`, `console` | `new URL(location)` then `url.hostname` (inside try/catch with a regex fallback); `console.warn(...)` ×2 |
| cmmc-aws | `Buffer`, `console` | `Buffer.from(x,"base64").toString("utf-8")`; `console.log("INFO: API Gateway ...")` |
| hitrust-aws | `Buffer`, `console` | same `Buffer` pattern; `console.log` INFO |
| iso-27001-aws | `Buffer`, `console` | same `Buffer` pattern; `console.log` INFO and `console.warn` ×1 |
| nist-aws | none | – |
| pci-dss-aws | `Buffer`, `console` | same `Buffer` pattern; `console.log` INFO |
| pulumi-best-practices-aws | none | – |
| pure-examples | none | – |

`atob` and `btoa` are never used.

**Action for the Go prelude:** every `Buffer` call is `Buffer.from(<string>, "base64").toString("utf-8")`, spelled with a **hyphen**, so the Go prelude must accept `"utf-8"` as well as `"utf8"`.

The ECMAScript built-ins referenced are `Array, Boolean, Date, Error, JSON, Map, Math, Number, Object, RegExp, Set, String, SyntaxError, isFinite, isNaN, parseFloat`, plus `globalThis`. Every other free identifier fails the build.

## Forbidden-pattern gate

`scripts/pure/check-output.mjs` parses each bundle with acorn (ecmaVersion 2020, script), so bundles using syntax newer than ES2020 fail. The build fails on any code-position:
- `require`, `process`, `setTimeout`/`setInterval`/`setImmediate`, `queueMicrotask`, `Intl`, `structuredClone`, `TextEncoder`/`TextDecoder`, `fetch`, `module`, `exports`, `__dirname`/`__filename`, `global`, `eval`, `Function`
- any other unknown free identifier
- a `.groupBy` member
- async functions, `await` or `for await`
- `import()`
- `\p{`/`\P{` in regex literals or in `new RegExp("...")` strings

It also fails on esbuild `import-is-undefined` warnings, which catch a stubbed provider export that does not exist.

**Sanity check:** a synthetic bad bundle trips every rule, and all 8 real bundles pass.

**Whitelist.** Raw grep hits that sit only inside string or template literals are allowed and reported. They all come from `remediationSteps` TypeScript snippets such as `process.env`, `import ... from "path"`, `async`, or from ordinary strings such as `"url"`/`"path"`:

| bundle | raw hits inside literals only |
|---|---|
| cis-aws | `process.` ×20, node-builtin-looking strings ×10 |
| cmmc-aws | node-builtin-looking strings ×7 |
| hitrust-aws | `process.` ×1, builtin strings ×13 |
| iso-27001-aws | `process.` ×3, builtin strings ×21 |
| nist-aws | `process.` ×2, `async ` ×1, builtin strings ×15 |
| pci-dss-aws | `process.` ×1, builtin strings ×9 |
| pulumi-best-practices-aws | `process.` ×1, `async ` ×1, builtin strings ×8 |

There are no `require(`, `setTimeout`, `Intl.`, `structuredClone`, `TextEncoder`, `groupBy` or `\p{` hits anywhere, not even in strings. One limitation: declared-name tracking is not scope-aware, so a local variable named `process` would mask a global use. The raw hit counts above make such a case visible.

## goja risk notes

- **Syntax kept at `target: es2020`.** Counts per bundle:
  - `?.`: 41–420
  - `??`: 23–294
  - optional catch binding `catch{`: 4–20
  - `for…of`: 55–157
  - arrow functions, template literals, destructuring, object spread (one, in the shim), and default params

  Lowered by esbuild: class fields and `??=`. There are no class fields, getters/setters, generators, async or labels. There are exactly 2 classes (`NotApplicableSignal` and `PolicyPack`, both in the shim), and nothing uses `super`. If goja rejects `?.`/`??`, build with `PURE_TARGET=es2019`; cis-aws grows from 342,520 to 347,291 bytes (+1.4%) and the build was verified. Optional catch binding stays even at es2019.
- **Regex.** The bundles have 15–90 regex literals each, plus dynamic `new RegExp(...)` from `shared/utils/exemption-matching.ts`, which builds anchored and escaped wildcard patterns from user config.
  - **Lookbehind:** 2 regexes, both in `no-hardcoded-secrets` (hitrust, iso-27001 and pci-dss): `/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/=])/g` and `/(?<![\w-])-p(?!\d+[:/])['"]?[^\s'"]{8,}['"]?/gi`.
  - **Lookahead:** several (`(?!`), which need goja's regexp2 fallback.
  - **Not used:** named groups, the `u`/`y`/`s` flags, and `\p{}`.
- **`keepNames`** emits `__name(fn,"name")`, which is `Object.defineProperty(fn,"name",{value,configurable:true})` on many functions. goja allows this because function `name` is configurable.
- **Built-in methods.** `Array.prototype.flatMap` is used once (cis). `includes`/`startsWith`/`endsWith` are used everywhere. `Object.entries`, `Array.from(new Set(...))`, and `Map`/`Set` iteration are common. `localeCompare`, `toLocale*`, `Intl`, `matchAll`, `replaceAll`, `at` and `hasOwn` are not used.
- **`e instanceof SyntaxError`** after `JSON.parse` (cis IAM policy parsing) requires goja's `JSON.parse` to throw a real `SyntaxError`. If it does not, the policy logs nothing, but no violation changes.
- **Wall clock.** `new Date()` is used in 2 cis policies (EC2 stopped-instance age and IAM access-key age), and `new Date(<ISO string>)` parses timestamps. Their results depend on the host clock and on goja's Date parsing.
- **Console noise.** An API Gateway policy in cmmc, hitrust, iso-27001 and pci-dss calls `console.log("INFO: ...")` when it sees Cognito authorizers, and policies in cis and iso-27001 call `console.warn` on unparsable policy JSON. The host prelude should route these somewhere harmless.
- **Cross-realm objects.** Under node `vm`, props created outside the context would fail `instanceof Array`. The harness therefore creates them inside the realm, which goja does naturally.
- **Size and parse.** The largest bundle (iso-27001) is 625 KB, about 55% of it string literals. The node vm compile takes about 5 ms and the top-level run about 1.5–2 ms. goja will be slower, and these numbers are a proxy only.

## Unexpected things found and how they were handled

- **`"type": "commonjs"` in `packs/cis/aws` and `packs/cmmc/aws` package.json.** esbuild treated those ESM `.ts` files as CommonJS and wrapped every import in lazy `__esm` initializers, which defeated tree-shaking: cmmc was 399 KB with 210 KB of stubs. Fix: the plugin resolves local `.ts` imports itself, so the package.json `type` hint no longer applies. Every bundled input is now ESM.
- **Empty provider namespaces.** Some namespaces (for example `aws.billing`, `aws.pricing`) contain only data-source functions, so their stubs were empty. esbuild treated those as CJS and pulled in `__commonJS`/`__toESM` helpers. Fix: empty stubs emit `export {}`, and the root barrel skips them. The only helpers left in the bundles are `__defProp` and `__name`.
- **`@pulumi/pulumi`** appears only as type imports (`UnwrappedObject`) or inside `remediationSteps` strings. It is stubbed to an empty module, and any runtime use would fail the build through the `import-is-undefined` or unknown-global checks.
- **`@pulumi/kubernetes`** is not imported by any of the 7 AWS packs. The plugin supports it anyway, including nested namespaces like `core/v1`.
- **No pack index reads the filesystem, `process.env`, or uses a dynamic `require`.**
- **`validateStackResourcesOfType`** is implemented but not used by any of the 7 packs, and none of their stack policies is tagged.
- **Enums.** Enum objects such as `aws.ec2.InstanceType` are harvested into the stubs for correctness. They are unused and shaken out.
