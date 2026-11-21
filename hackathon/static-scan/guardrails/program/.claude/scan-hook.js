#!/usr/bin/env node
// Claude Code PostToolUse hook: after an edit to the program, run `pulumi policy scan` for dev and prod. With
// mandatory findings, print them to stderr and exit 2, which hands them to the agent as feedback on its edit.
//
// PULUMI (the CLI) and GUARDRAILS_PACK (the pack) can be set in the environment; the defaults are the dev CLI from the
// hackathon/scan-guardrails worktree and the pack next to this program in the showcase.
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let input = {};
try {
    input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {
    // No input: scan anyway.
}
const file = (input.tool_input && (input.tool_input.file_path || input.tool_input.path)) || "";
if (file && !/\.(ts|js|ya?ml|json)$/.test(file)) {
    process.exit(0);
}
const G = path.join(os.homedir(), "go", "src", "github.com", "pulumi");
const cli = process.env.PULUMI || path.join(G, "pulumi-scan-guardrails", "bin", "pulumi");
const pack = process.env.GUARDRAILS_PACK || path.join(project, "..", "pack");

const problems = [];
for (const stack of ["dev", "prod"]) {
    let out;
    try {
        out = execFileSync(cli, ["policy", "scan", project, "--policy-pack", pack, "--stack", stack, "--json"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch (err) {
        out = err.stdout; // non-zero exit with mandatory findings still prints the report
    }
    let r;
    try {
        r = JSON.parse(out);
    } catch {
        problems.push(`[${stack}] the scan didn't produce a report`);
        continue;
    }
    for (const e of r.errors || []) {
        problems.push(`[${stack}] the program didn't finish: ${e.split("\n")[0]}`);
    }
    for (const f of r.findings) {
        if (f.enforcementLevel === "mandatory") {
            const where = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "(stack)";
            problems.push(`[${stack}] ${where} ${f.policy}: ${f.message.split("\n").slice(1).join(" ")}`);
        }
    }
}
// A trace of every run: stream-json transcripts don't include hook output.
try {
    fs.appendFileSync(
        path.join(project, ".claude", "scan-hook.log"),
        `${new Date().toISOString()} ${path.relative(project, file) || "-"} mandatory=${problems.length}\n`,
    );
} catch {
    // Tracing only.
}
if (problems.length > 0) {
    process.stderr.write(`policy scan after this edit: ${problems.length} mandatory finding(s)\n${problems.join("\n")}\n`);
    process.exit(2);
}
process.exit(0);
