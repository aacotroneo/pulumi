#!/usr/bin/env node
// agent-rules.js [pack dir]: prints an agent-instructions section (for CLAUDE.md / AGENTS.md) generated from the
// guardrails pack: the approved choices, then every policy with its level, description and fix. The rules come from
// the same file the scan runs, so the instructions and the checks can't drift apart.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dir = path.resolve(process.argv[2] || path.join(__dirname, "pack"));
const sandbox = { console };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(dir, "policies.js"), "utf8"), sandbox, { filename: "policies.js" });
const pack = sandbox.__pulumiPolicyPack;
const A = sandbox.__acmeGuardrailsApproved || {};

const out = [];
out.push(`## Infrastructure guardrails (${pack.name} ${pack.version})`, "");
out.push(
    "This program is checked by a policy pack. Write code that passes it the first time; then check with",
    "`pulumi policy scan . --policy-pack <pack> --stack dev` (and `--stack prod`). Mandatory findings must be fixed.",
    "",
);
out.push("### Approved choices", "");
out.push(`- Every resource and component gets the team provider: \`${A.provider}\`, with \`import * as platform from "@acme/platform"\`.`);
for (const [type, call] of Object.entries(A.components || {})) {
    out.push(`- \`${type}\`: \`${call}\``);
}
if (A.postgresSizes) {
    out.push(`- Postgres sizes: dev ${A.postgresSizes.dev.join("/")}, prod ${A.postgresSizes.prod.join("/")} (choose with \`pulumi.getStack()\`).`);
}
if (A.instanceFamilies) {
    out.push(`- EC2 families: dev ${A.instanceFamilies.dev.join(", ")} (up to ${A.maxDevInstanceSize}); prod ${A.instanceFamilies.prod.join(", ")}.`);
}
if (A.logRetentionDays) {
    out.push(`- Log retention: at least ${A.logRetentionDays.dev} days in dev, ${A.logRetentionDays.prod} in prod.`);
}
if (A.managedPolicyArns) {
    out.push(`- AWS managed policies allowed: ${A.managedPolicyArns.map((a) => `\`${a}\``).join(", ")}.`);
}
if (A.sharedInfra) {
    const byOwner = {};
    for (const [t, [owner]] of Object.entries(A.sharedInfra)) {
        (byOwner[owner] = byOwner[owner] || []).push(t.split(":").pop());
    }
    out.push(`- Shared infrastructure, only in its owner's directory (elsewhere use a stack reference): ${Object.entries(byOwner).map(([o, ts]) => `${ts.join(", ")} → ${o}`).join("; ")}.`);
}
if (A.forbiddenTypes) {
    out.push(`- Never create: ${A.forbiddenTypes.map((t) => `\`${t}*\``).join(", ")}.`);
}
if (A.locations) {
    out.push(`- Resources live in ${A.locations.join(" or ")}; \`index.ts\` only wires modules and exports outputs.`);
}
out.push("", "### Policies", "");
for (const p of pack.policies) {
    const level = p.enforcementLevel === "mandatory" ? "**mandatory**" : p.enforcementLevel;
    out.push(`- \`${p.name}\` (${level}): ${p.description}${p.remediationSteps ? ` Fix: ${p.remediationSteps}` : ""}`);
}
out.push("");
process.stdout.write(out.join("\n"));
