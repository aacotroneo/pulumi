// Acme guardrails: a hand-written purejs policy pack (ABI v1, no build step) for `pulumi policy scan`.
//
// These policies are about how infrastructure code is written, not only how the cloud is configured: golden-path
// components, conventions, Pulumi best practices. They're written for an agent (or a person) in an edit-scan loop, so
// each message says what to change, where, and with which API.
//
// What a policy sees:
//   - resource policies: input.{type,name,urn,props} (the inputs the program declared; secrets unwrapped);
//   - stack policies: input.resources[], each {type,name,urn,props,parent,dependencies,propertyDependencies}. An
//     output that only a deployment knows is an "identifiable unknown": the same text ("output-<hash>.id") wherever
//     the program used it, so `rule.props.securityGroupId === group.props.id` works before deployment;
//   - the scan context (hackathon/scan-guardrails): the Stack resource's props.scan, read with scanContext(). It has
//     each resource's file:line, options, provider, secret inputs and createdInApply, and the program's imports,
//     config reads, side effects, package.json and Pulumi.yaml. Only stack policies can see it.
//
// A stack policy can place a finding on any line of code by reporting it on "<stack urn>#<file>:<line>".

const STACK = "pulumi:pulumi:Stack";
const UNKNOWN = { unknown: true };
const isUnknown = (v) => v === UNKNOWN || (typeof v === "string" && /^output-[0-9a-f]{16}\./.test(v));

// read(obj, "a.b.c"): the value, undefined if missing, or UNKNOWN if a deployment-only value is in the way.
function read(obj, path) {
    let v = obj;
    for (const k of path.split(".")) {
        if (v === null || v === undefined || typeof v !== "object") {
            return undefined;
        }
        try {
            v = v[k];
        } catch (e) {
            return UNKNOWN;
        }
    }
    return v;
}

// Every string in a value, with its path; unknown parts are skipped.
function strings(v, path, out) {
    out = out || [];
    if (typeof v === "string") {
        out.push([path, v]);
    } else if (v && typeof v === "object") {
        let keys = [];
        try {
            keys = Object.keys(v);
        } catch (e) {
            return out;
        }
        for (const k of keys) {
            let e;
            try {
                e = v[k];
            } catch (err) {
                continue;
            }
            strings(e, path ? `${path}.${k}` : k, out);
        }
    }
    return out;
}

function scanContext(resources) {
    const s = resources.find((r) => r.type === STACK);
    const ctx = s && read(s.props, "scan");
    return ctx && ctx !== UNKNOWN ? ctx : undefined;
}

// The resource graph plus the scan context, with the lookups the policies share.
function graph(resources) {
    const ctx = scanContext(resources);
    const byUrn = {};
    resources.forEach((r) => (byUrn[r.urn] = r));
    const stack = resources.find((r) => r.type === STACK);
    const info = (r) => (ctx && ctx.resources[r.urn]) || {};
    const ancestors = (r) => {
        const out = [];
        for (let p = byUrn[r.parent]; p && p.type !== STACK; p = byUrn[p.parent]) {
            out.push(p);
        }
        return out;
    };
    const where = (r) => (info(r).file ? `${info(r).file}:${info(r).line}` : "an unknown line");
    const teamOf = (file) => {
        const m = /^src\/([^/]+)\//.exec(file || "");
        return m ? m[1] : undefined;
    };
    const isProvider = (r) => r.type.startsWith("pulumi:providers:");
    const isCustom = (r) => info(r).custom === true;
    return {
        ctx,
        byUrn,
        info,
        ancestors,
        where,
        teamOf,
        isProvider,
        isCustom,
        stackName: ctx && ctx.stack,
        project: ctx && ctx.project.name,
        // A finding on a line of code that isn't a resource's (a config read, an import).
        at: (file, line) => `${stack ? stack.urn : ""}#${file}:${line || 0}`,
    };
}

// A provider's default tags. Provider inputs reach policies JSON-encoded (`defaultTags` is a string).
function providerTags(p) {
    let v = read(p.props, "defaultTags");
    if (typeof v === "string" && !isUnknown(v)) {
        try {
            v = JSON.parse(v);
        } catch (e) {
            return undefined;
        }
    }
    const tags = read(v, "tags");
    return tags === UNKNOWN ? UNKNOWN : tags || {};
}

const PLATFORM_IMPORT = 'import * as platform from "@acme/platform"';
const providerHint = (team) => `const provider = platform.provider("${team || "<team>"}")`;

// Inside a component the platform owns, the component is the thing to check (and to report on).
const PLATFORM_COMPONENTS = ["acme:storage:Bucket", "acme:db:Postgres", "acme:network:Service", "acme:iam:Role"];

// The approved choices, in one place: the policies enforce them, and agent-rules.js turns them into instructions.
const APPROVED = {
    components: {
        "acme:storage:Bucket": 'new platform.storage.Bucket(name, { team, dataClass: "public" | "internal" | "confidential" }, { provider })',
        "acme:db:Postgres": 'new platform.db.Postgres(name, { team, size, password: config.requireSecret(key) }, { provider, protect: isProd })',
        "acme:network:Service": "new platform.network.Service(name, { team, vpcId, port, publicSubnetIds? }, { provider })",
        "acme:iam:Role": 'new platform.identity.Role(name, { team, service: "lambda.amazonaws.com", managedPolicyArns }, { provider })',
    },
    provider: 'const provider = platform.provider("<team>")',
    postgresSizes: { dev: ["small"], prod: ["medium", "large"], other: ["small", "medium"] },
    instanceFamilies: { dev: ["t3", "t4g"], prod: ["t3", "t4g", "m6i", "m7g", "c7g", "r6g"] },
    maxDevInstanceSize: "medium",
    dbClassFamilies: { dev: ["db.t3", "db.t4g"], prod: ["db.t4g", "db.m6g", "db.r6g", "db.m7g", "db.r7g"] },
    logRetentionDays: { dev: 7, prod: 90 },
    rdsBackupDays: 7,
    managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
        "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
        "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ],
    sharedInfra: {
        "aws:ec2/vpc:Vpc": ["src/network/", "the network stack: `new pulumi.StackReference(`acme/network/${pulumi.getStack()}`).requireOutput(\"vpcId\")`"],
        "aws:ec2/subnet:Subnet": ["src/network/", "the network stack's `privateSubnetIds` / `publicSubnetIds` outputs"],
        "aws:ec2/natGateway:NatGateway": ["src/network/", "the network stack (its private subnets already route through NAT)"],
        "aws:ec2/internetGateway:InternetGateway": ["src/network/", "the network stack's public subnets"],
        "aws:kms/key:Key": ["platform/", "the platform stack's keys (`acme/platform/<stack>` output `dataKeyArn`), or a platform component that encrypts for you"],
        "aws:route53/zone:Zone": ["platform/", "the platform stack's zones (`acme/platform/<stack>` output `zoneId`)"],
    },
    forbiddenTypes: ["aws:organizations/", "aws:account/", "aws:iam/accountAlias:", "aws:iam/accountPasswordPolicy:", "aws:iam/samlProvider:", "aws:iam/openIdConnectProvider:"],
    locations: ["src/<team>/", "platform/"],
    // USD per month, rough on-demand list prices; enough to rank and to catch an order of magnitude.
    prices: {
        "t3.micro": 7.5, "t3.small": 15, "t3.medium": 30, "t4g.small": 12, "t4g.medium": 24, "m6i.large": 70,
        "m6i.xlarge": 140, "m6i.4xlarge": 560, "c7g.large": 52,
        "db.t3.micro": 13, "db.t4g.small": 25, "db.t4g.medium": 50, "db.r6g.large": 175, "db.r6g.2xlarge": 700,
        natGateway: 33, loadBalancer: 18,
    },
};
globalThis.__acmeGuardrailsApproved = APPROVED;
const POSTGRES_CLASS = { small: "db.t4g.small", medium: "db.r6g.large", large: "db.r6g.2xlarge" };
const insidePlatform = (g, r) => g.ancestors(r).some((a) => a.type.startsWith("acme:"));

const policies = [
    // ------------------------------------------------------------------------------------------------------------
    // Golden paths and components
    // ------------------------------------------------------------------------------------------------------------
    {
        name: "use-platform-bucket",
        description: "S3 buckets are created with the @acme/platform storage component, not the raw AWS resource.",
        enforcementLevel: "mandatory",
        severity: "high",
        remediationSteps: "Replace the raw bucket with `new platform.storage.Bucket(name, { team, dataClass }, { provider })`.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            for (const r of input.resources) {
                if (r.type !== "aws:s3/bucket:Bucket" && r.type !== "aws:s3/bucketV2:BucketV2") {
                    continue;
                }
                if (g.ancestors(r).some((a) => a.type === "acme:storage:Bucket")) {
                    continue;
                }
                const team = g.teamOf(g.info(r).file);
                ctx.reportViolation(
                    `Bucket '${r.name}' at ${g.where(r)} is a raw ${r.type.split(":").pop()}. Replace it with the ` +
                        `platform component: \`new platform.storage.Bucket("${r.name}", { team: "${team || "<team>"}", ` +
                        `dataClass: "internal" }, { provider })\` (${PLATFORM_IMPORT}; dataClass is "public", "internal" ` +
                        `or "confidential"). It adds encryption, versioning, a public access block and tags. Use ` +
                        `\`.bucketName\` and \`.arn\` where you used the raw bucket's \`bucket\` and \`arn\`.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "use-platform-database",
        description: "Databases are created with the @acme/platform Postgres component, not raw RDS resources.",
        enforcementLevel: "mandatory",
        severity: "high",
        remediationSteps: "Replace the raw RDS resource with `new platform.db.Postgres(name, { team, size, password }, { provider })`.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            for (const r of input.resources) {
                if (r.type !== "aws:rds/instance:Instance" && r.type !== "aws:rds/cluster:Cluster") {
                    continue;
                }
                if (g.ancestors(r).some((a) => a.type === "acme:db:Postgres")) {
                    continue;
                }
                const team = g.teamOf(g.info(r).file);
                ctx.reportViolation(
                    `Database '${r.name}' at ${g.where(r)} is a raw ${r.type.split(":").pop()}. Use the platform ` +
                        `component: \`new platform.db.Postgres("${r.name}", { team: "${team || "<team>"}", size: "small", ` +
                        `password: config.requireSecret("<key>") }, { provider, protect: pulumi.getStack() === "prod" })\` ` +
                        `(${PLATFORM_IMPORT}). It is private, encrypted and backed up. Read replicas aren't offered by ` +
                        `the platform yet: ask the platform team instead of creating raw RDS.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "approved-platform-modules",
        description: "Only supported @acme/platform modules and components are used; deprecated ones are not.",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Import from `@acme/platform` and use its supported components.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const deprecated = {
                "@acme/platform/legacy": "deprecated since @acme/platform 2.0",
            };
            const replacements = {
                "acme:legacy:Queue":
                    "a plain `new aws.sqs.Queue(name, { ... }, { provider })` (the platform has no queue component yet)",
            };
            for (const imp of g.ctx.program.imports) {
                if (deprecated[imp.module] && !imp.file.startsWith("platform/")) {
                    ctx.reportViolation(
                        `${imp.file}:${imp.line} imports \`${imp.module}\`, ${deprecated[imp.module]}. Remove the import ` +
                            `and use the supported components from \`${PLATFORM_IMPORT}\` (storage.Bucket, db.Postgres, ` +
                            `network.Service).`,
                        g.at(imp.file, imp.line),
                    );
                }
            }
            for (const r of input.resources) {
                if (r.type.startsWith("acme:") && PLATFORM_COMPONENTS.indexOf(r.type) < 0) {
                    ctx.reportViolation(
                        `'${r.name}' at ${g.where(r)} is a ${r.type}, which is not a supported platform component. ` +
                            `Replace it with ${replacements[r.type] || `one of ${PLATFORM_COMPONENTS.join(", ")}`}.`,
                        r.urn,
                    );
                }
            }
            const platform = g.ctx.program.localPackages["@acme/platform"];
            if (platform && platform.version && parseInt(platform.version, 10) < 2) {
                ctx.reportViolation(
                    `@acme/platform is ${platform.version}; version 2 or later is required. Update the dependency.`,
                );
            }
        },
    },
    {
        name: "postgres-size-by-stack",
        description: "Platform databases use the sizes allowed for the stack: small in dev, medium or large in prod.",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Pick a size allowed in this stack, per stack (config), not one size for all stacks.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const allowed = { dev: ["small"], prod: ["medium", "large"] }[g.stackName] || ["small", "medium"];
            for (const r of input.resources) {
                if (r.type !== "acme:db:Postgres") {
                    continue;
                }
                const size = read(r.props, "size");
                if (isUnknown(size) || allowed.indexOf(size) >= 0) {
                    continue;
                }
                ctx.reportViolation(
                    `Database '${r.name}' at ${g.where(r)} has size "${size}", but stack "${g.stackName}" allows ` +
                        `${allowed.map((s) => `"${s}"`).join(" or ")}. If the size comes from config, set it in ` +
                        `Pulumi.${g.stackName}.yaml (e.g. \`${g.project}:dbSize: ${allowed[0]}\`); otherwise choose it ` +
                        `per stack in code. Don't change other stacks' sizes.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "bucket-component-invariants",
        description: "Every acme:storage:Bucket has a public access block, versioning and server-side encryption.",
        enforcementLevel: "mandatory",
        severity: "high",
        remediationSteps: "Fix the component in @acme/platform so every instance gets all three children.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            for (const c of input.resources) {
                if (c.type !== "acme:storage:Bucket") {
                    continue;
                }
                const kids = input.resources.filter((r) => r.parent === c.urn);
                const has = (type, ok) => kids.some((k) => k.type === type && (!ok || ok(k)));
                const missing = [];
                if (
                    !has("aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock", (k) =>
                        ["blockPublicAcls", "blockPublicPolicy", "ignorePublicAcls", "restrictPublicBuckets"].every(
                            (f) => read(k.props, f) === true,
                        ),
                    )
                ) {
                    missing.push("a public access block with all four settings on");
                }
                if (!has("aws:s3/bucketVersioning:BucketVersioning", (k) => read(k.props, "versioningConfiguration.status") === "Enabled")) {
                    missing.push("versioning enabled");
                }
                if (!has("aws:s3/bucketServerSideEncryptionConfiguration:BucketServerSideEncryptionConfiguration")) {
                    missing.push("server-side encryption");
                }
                if (missing.length === 0) {
                    continue;
                }
                const impl = kids.map((k) => g.info(k).file).find((f) => f) || "the component's source";
                ctx.reportViolation(
                    `acme:storage:Bucket '${c.name}' (declared at ${g.where(c)}, dataClass ` +
                        `"${read(c.props, "dataClass")}") has no ${missing.join(", no ")}. This is a bug in the component, ` +
                        `not in the code that uses it: fix the Bucket class in ${impl} so every instance gets them. Don't ` +
                        `add the missing resources from app code.`,
                    c.urn,
                );
            }
        },
    },
    {
        name: "component-encapsulation",
        description: "Code outside a platform component doesn't attach resources to the component's internals.",
        enforcementLevel: "mandatory",
        severity: "high",
        remediationSteps: "Use the component's own methods or inputs instead of attaching to its children.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            const api = {
                "acme:network:Service": "`service.allowFrom(name, privateCidr)` (private CIDRs only)",
                "acme:storage:Bucket": "the component's inputs (ask the platform team if none fits)",
                "acme:db:Postgres": "the component's inputs (ask the platform team if none fits)",
            };
            // The id of every resource inside a platform component, by value. Before deployment it is an identifiable
            // unknown, the same text wherever the program used it. Only `id`: attaching a resource to another goes by
            // its id, while `arn` is often an output the component exposes on purpose (a role's arn for a function).
            const owned = {};
            for (const r of input.resources) {
                const comp = g.ancestors(r).find((a) => PLATFORM_COMPONENTS.indexOf(a.type) >= 0);
                if (!comp) {
                    continue;
                }
                for (const f of ["id"]) {
                    const v = read(r.props, f);
                    if (typeof v === "string" && v) {
                        owned[v] = { child: r, comp };
                    }
                }
            }
            for (const r of input.resources) {
                if (r.type === STACK) {
                    continue;
                }
                const mine = g.ancestors(r);
                for (const [path, v] of strings(r.props, "")) {
                    const o = owned[v];
                    if (!o || o.child === r || mine.indexOf(o.comp) >= 0 || path === "id" || path === "arn") {
                        continue;
                    }
                    ctx.reportViolation(
                        `'${r.name}' (${r.type.split(":").pop()}) at ${g.where(r)} attaches to '${o.child.name}' ` +
                            `through \`${path}\`, but that ${o.child.type.split(":").pop()} belongs to ${o.comp.type} ` +
                            `'${o.comp.name}'. Don't change a component's internals from outside: use ` +
                            `${api[o.comp.type] || "the component's API"}, and remove '${r.name}'.`,
                        r.urn,
                    );
                    break;
                }
            }
        },
    },

    // ------------------------------------------------------------------------------------------------------------
    // Naming
    // ------------------------------------------------------------------------------------------------------------
    {
        name: "kebab-case-names",
        description: "Logical resource names are kebab-case.",
        enforcementLevel: "mandatory",
        severity: "low",
        remediationSteps: "Rename the resource to its kebab-case form.",
        kind: "resource",
        validate(input, ctx) {
            if (input.type.startsWith("pulumi:pulumi:") || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.name)) {
                return;
            }
            const kebab = input.name
                .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
                .replace(/[^A-Za-z0-9]+/g, "-")
                .replace(/^-|-$/g, "")
                .toLowerCase();
            ctx.reportViolation(
                `Rename '${input.name}' to '${kebab}': logical names are kebab-case.`,
            );
        },
    },
    {
        name: "physical-name-prefix",
        description: "Explicit physical names start with <project>-<stack>-; otherwise leave them out for auto-naming.",
        enforcementLevel: "mandatory",
        severity: "low",
        remediationSteps: "Remove the explicit name, or prefix it with `${pulumi.getProject()}-${pulumi.getStack()}-`.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const prefix = `${g.project}-${g.stackName}-`;
            for (const r of input.resources) {
                if (!g.isCustom(r) || g.isProvider(r) || g.info(r).read || insidePlatform(g, r)) {
                    continue;
                }
                for (const f of ["name", "bucket", "identifier"]) {
                    const v = read(r.props, f);
                    if (typeof v !== "string" || isUnknown(v) || v.startsWith(prefix)) {
                        continue;
                    }
                    ctx.reportViolation(
                        `'${r.name}' at ${g.where(r)} sets \`${f}: "${v}"\`, a physical name that will collide across ` +
                            `stacks. Remove \`${f}\` so Pulumi auto-names it (preferred), or prefix it: ` +
                            `\`${f}: \`\${pulumi.getProject()}-\${pulumi.getStack()}-${v}\`\`.`,
                        r.urn,
                    );
                }
            }
        },
    },

    // ------------------------------------------------------------------------------------------------------------
    // Code and files
    // ------------------------------------------------------------------------------------------------------------
    {
        name: "team-ownership",
        description: "Resources declared under src/<team>/ belong to that team (component `team` input, or a team tag).",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Set the team to the directory's team, or move the code to the owning team's directory.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            for (const r of input.resources) {
                const team = g.teamOf(g.info(r).file);
                if (!team || g.isProvider(r) || g.info(r).read || r.type.startsWith("pulumi:")) {
                    continue;
                }
                let found, how;
                if (!g.isCustom(r)) {
                    found = read(r.props, "team");
                    how = "its `team` input";
                } else {
                    found = read(r.props, "tags.team");
                    how = "its `team` tag";
                    if (found === undefined && g.info(r).provider && g.byUrn[g.info(r).provider]) {
                        const tags = providerTags(g.byUrn[g.info(r).provider]);
                        found = tags === UNKNOWN ? UNKNOWN : tags && tags.team;
                        how = "its provider's default `team` tag";
                    }
                }
                if (isUnknown(found) || found === team) {
                    continue;
                }
                ctx.reportViolation(
                    found === undefined
                        ? `'${r.name}' at ${g.where(r)} has no owning team. Code in src/${team}/ belongs to ${team}: ` +
                              `pass \`{ provider }\` with \`${providerHint(team)}\` (it tags team=${team}), or set ` +
                              `\`tags: { team: "${team}" }\`.`
                        : `'${r.name}' at ${g.where(r)} is declared in src/${team}/ but ${how} says "${found}". Set it ` +
                              `to "${team}", or move the resource to src/${found}/ if ${found} owns it.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "no-resources-in-entrypoint",
        description: "The entry point (index.ts) only wires team modules together; it declares no resources.",
        enforcementLevel: "advisory",
        severity: "low",
        remediationSteps: "Move the resource into the owning team's module and export what index.ts needs.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const entry = (g.ctx.project.main || g.ctx.program.packageJson.main || "index.ts").replace(/^\.\//, "");
            const entries = [entry, "index.ts", "index.js"];
            for (const r of input.resources) {
                if (entries.indexOf(g.info(r).file) < 0 || g.isProvider(r) || r.type.startsWith("pulumi:")) {
                    continue;
                }
                ctx.reportViolation(
                    `'${r.name}' is declared in the entry point (${g.where(r)}). Move it into the owning team's module ` +
                        `(src/<team>/index.ts, with that team's provider), export it there, and re-export from ` +
                        `${g.info(r).file} only what other stacks need.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "no-resources-in-apply",
        description: "Resources are not created inside apply callbacks.",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Create the resource at the top level and pass the Output as its input.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            for (const r of input.resources) {
                if (!g.info(r).createdInApply) {
                    continue;
                }
                ctx.reportViolation(
                    `'${r.name}' is created inside an \`apply\` callback (${g.where(r)}). Previews don't show such ` +
                        `resources reliably and their dependencies are hidden. Create it at the top level and pass the ` +
                        `Output as the input; build strings with \`pulumi.interpolate\`, e.g. ` +
                        `\`value: pulumi.interpolate\`postgres://\${db.endpoint}/app\`\`.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "hermetic-program",
        description: "The program doesn't run processes or reach the network while it deploys.",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Pass the value in through stack config instead of computing it at deploy time.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            for (const s of g.ctx.program.sideEffects) {
                const what = s.kind === "process" ? `runs \`${s.target}\`` : `calls ${s.kind} ${s.target}`;
                ctx.reportViolation(
                    `${s.file || "The program"}:${s.line || "?"} ${what} at deploy time. Programs must be hermetic: the ` +
                        `result differs between laptops, CI and Deployments, and previews can't see it. Pass the value in ` +
                        `as stack config (declared in Pulumi.yaml, read with \`config.get("...")\`) and remove the call.`,
                    g.at(s.file, s.line),
                );
            }
        },
    },

    // ------------------------------------------------------------------------------------------------------------
    // Pulumi best practices
    // ------------------------------------------------------------------------------------------------------------
    {
        name: "protect-stateful-in-prod",
        description: "In prod, resources that hold data are protected (protect or retainOnDelete).",
        enforcementLevel: "mandatory",
        severity: "high",
        remediationSteps: "Add `protect: pulumi.getStack() === \"prod\"` to the resource options.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx || g.stackName !== "prod") {
                return;
            }
            const stateful = (r) =>
                r.type === "acme:db:Postgres" ||
                (r.type === "acme:storage:Bucket" && read(r.props, "dataClass") === "confidential") ||
                [
                    "aws:rds/instance:Instance",
                    "aws:rds/cluster:Cluster",
                    "aws:s3/bucket:Bucket",
                    "aws:s3/bucketV2:BucketV2",
                    "aws:dynamodb/table:Table",
                ].indexOf(r.type) >= 0;
            for (const r of input.resources) {
                // A component's children are covered by the component.
                if (!stateful(r) || insidePlatform(g, r)) {
                    continue;
                }
                const o = g.info(r).options || {};
                if (o.protect === true || o.retainOnDelete === true) {
                    continue;
                }
                ctx.reportViolation(
                    `'${r.name}' at ${g.where(r)} holds data and isn't protected in prod. Add \`protect: ` +
                        `pulumi.getStack() === "prod"\` (or \`retainOnDelete: true\`) to its resource options, next to ` +
                        `\`provider\`.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "secrets-stay-secret",
        description: "Passwords and secret config stay secrets: in resource inputs and in how config is read.",
        enforcementLevel: "mandatory",
        severity: "critical",
        remediationSteps: "Read secret config with `config.requireSecret`/`getSecret`, and pass secrets as Outputs.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const sensitive = ["password", "masterPassword", "secretString", "privateKey", "apiKey", "token"];
            const flagged = {};
            for (const r of input.resources) {
                if (r.type === STACK || g.isProvider(r)) {
                    continue;
                }
                const secret = g.info(r).secretInputs || [];
                for (const f of sensitive) {
                    const v = read(r.props, f);
                    // A value from another resource's output can't be judged before deployment.
                    if (v === undefined || isUnknown(v) || secret.indexOf(f) >= 0) {
                        continue;
                    }
                    if (g.ancestors(r).some((a) => flagged[a.urn])) {
                        continue;
                    }
                    flagged[r.urn] = true;
                    ctx.reportViolation(
                        `'${r.name}' at ${g.where(r)} gets \`${f}\` as plain text, so it is stored unencrypted in the ` +
                            `state. Pass a secret: read it with \`config.requireSecret("...")\`, or wrap it with ` +
                            `\`pulumi.secret(...)\`.`,
                        r.urn,
                    );
                }
            }
            const declared = g.ctx.project.config || {};
            const stackCfg = g.ctx.project.stackConfig || {};
            for (const c of g.ctx.program.configRead) {
                const isSecret = (declared[c.key] && declared[c.key].secret) || (stackCfg[c.key] && stackCfg[c.key].secure);
                if (!isSecret || c.secret) {
                    continue;
                }
                const fixed = c.method.replace(/^(get|require)/, "$1Secret");
                ctx.reportViolation(
                    `${c.file}:${c.line} reads secret config \`${c.key}\` with \`config.${c.method}("${c.name}")\`, ` +
                        `which turns it into plain text. Use \`config.${fixed}("${c.name}")\`; it returns an Output ` +
                        `you can pass straight to the resource.`,
                    g.at(c.file, c.line),
                );
            }
        },
    },
    {
        name: "declared-config",
        description: "Every config key the program reads is declared in Pulumi.yaml with a type and description.",
        enforcementLevel: "mandatory",
        severity: "low",
        remediationSteps: "Declare the key under `config:` in Pulumi.yaml.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const declared = g.ctx.project.config || {};
            for (const c of g.ctx.program.configRead) {
                if (c.namespace !== g.project) {
                    continue;
                }
                const d = declared[c.key];
                if (d && d.description) {
                    continue;
                }
                const type = { Number: "integer", Boolean: "boolean", Object: "object" }[
                    (/(Number|Boolean|Object)$/.exec(c.method) || [])[1]
                ] || "string";
                ctx.reportViolation(
                    `${c.file}:${c.line} reads config \`${c.key}\`, which Pulumi.yaml ` +
                        `${d ? "declares without a description" : "doesn't declare"}. Add it under \`config:\` in ` +
                        `Pulumi.yaml: \`${c.name}: { type: ${type}, description: "<what it is>"` +
                        `${c.required ? "" : ", default: <value>"}${c.secret ? ", secret: true" : ""} }\`.`,
                    g.at(c.file, c.line),
                );
            }
        },
    },
    {
        name: "no-hardcoded-arns",
        description: "Resource inputs don't contain literal ARNs (account IDs included); ARNs come from resources, config or lookups.",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Use the resource's `.arn` output, a stack reference, aws.getCallerIdentityOutput, or config.",
        kind: "resource",
        validate(input, ctx) {
            if (input.type.startsWith("pulumi:providers:")) {
                return;
            }
            for (const [path, v] of strings(input.props, "")) {
                // AWS managed policies are global names, not resources of ours; identifiable unknowns are outputs.
                const m = /arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12})?:?[^\s"']*/.exec(v);
                if (!m || /^arn:aws:iam::aws:policy\//.test(m[0]) || /output-[0-9a-f]{16}\./.test(v)) {
                    continue;
                }
                ctx.reportViolation(
                    `'${input.name}' hardcodes the ARN \`${m[0]}\`${m[1] ? ` (account ${m[1]})` : ""} in \`${path}\`. ` +
                        `Reference it instead: the resource's \`.arn\` if this program creates it, a stack reference ` +
                        `output if another stack does, or build it with \`pulumi.interpolate\` from ` +
                        `\`aws.getCallerIdentityOutput({}, { provider }).accountId\` (use \`pulumi.jsonStringify\` for ` +
                        `policy documents).`,
                );
                return;
            }
        },
    },
    {
        name: "explicit-provider-default-tags",
        description: "AWS resources use the team's explicit provider, which sets default tags (team, env).",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Pass `{ provider }` from `platform.provider(team)` to every resource.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            for (const r of input.resources) {
                if (!g.isCustom(r) || g.isProvider(r) || !r.type.startsWith("aws:") || g.info(r).read) {
                    continue;
                }
                const team = g.teamOf(g.info(r).file);
                const p = g.byUrn[g.info(r).provider];
                if (!p) {
                    ctx.reportViolation(
                        `'${r.name}' at ${g.where(r)} uses the default AWS provider, so it gets no default tags and ` +
                            `follows whatever region the environment has. Pass \`{ provider }\` in its options, with ` +
                            `\`${providerHint(team)}\` (${PLATFORM_IMPORT}).`,
                        r.urn,
                    );
                    continue;
                }
                const tags = providerTags(p) || {};
                const missing = ["team", "env"].filter((t) => tags === UNKNOWN || !tags[t]);
                if (missing.length > 0) {
                    ctx.reportViolation(
                        `'${r.name}' at ${g.where(r)} uses provider '${p.name}', which has no default ` +
                            `${missing.join("/")} tags. Use \`${providerHint(team)}\` instead of a hand-made provider.`,
                        r.urn,
                    );
                }
            }
        },
    },
    {
        name: "no-ignore-changes-wildcard",
        description: "Resources don't ignore all changes (`ignoreChanges: [\"*\"]`).",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "List the specific properties another system manages, or remove ignoreChanges.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            for (const r of input.resources) {
                const ic = (g.info(r).options || {}).ignoreChanges || [];
                if (ic.indexOf("*") < 0) {
                    continue;
                }
                ctx.reportViolation(
                    `'${r.name}' at ${g.where(r)} has \`ignoreChanges: ["*"]\`, which hides every drift and every future ` +
                        `change to it. Remove the option, or list only the properties something else manages, e.g. ` +
                        `\`ignoreChanges: ["tags"]\`.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "dependency-hygiene",
        description: "package.json pins versions (no latest or *), with supported Pulumi SDK majors.",
        enforcementLevel: "advisory",
        severity: "low",
        remediationSteps: "Pin a version range in package.json and commit the lockfile.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const pj = g.ctx.program.packageJson;
            const local = g.ctx.program.localPackages || {};
            const minMajor = { "@pulumi/pulumi": 3, "@pulumi/aws": 7 };
            const deps = Object.assign({}, pj.devDependencies, pj.dependencies);
            for (const name of Object.keys(deps).sort()) {
                const range = String(deps[name]);
                if (local[name]) {
                    continue;
                }
                if (/^(latest|\*|x|)$/.test(range.trim()) || /^(git|https?):|^github:/.test(range)) {
                    ctx.reportViolation(
                        `package.json asks for \`"${name}": "${range}"\`. Pin a range (e.g. \`"^1.2.0"\`, the version ` +
                            `you tested) so scans, previews and deployments run the same code.`,
                        g.at("package.json", 0),
                    );
                    continue;
                }
                const m = /(\d+)/.exec(range);
                if (minMajor[name] && m && parseInt(m[1], 10) < minMajor[name]) {
                    ctx.reportViolation(
                        `package.json asks for ${name} ${range}; major ${minMajor[name]} or later is required.`,
                        g.at("package.json", 0),
                    );
                }
            }
        },
    },

    // ------------------------------------------------------------------------------------------------------------
    // Size, retention and cost per stack
    // ------------------------------------------------------------------------------------------------------------
    {
        name: "instance-types-by-stack",
        description: "EC2 instance types and RDS classes come from the families allowed in the stack (burstable in dev).",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Pick an allowed family for this stack, per stack.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const st = g.stackName === "prod" ? "prod" : "dev";
            const sizes = ["nano", "micro", "small", "medium", "large", "xlarge"];
            for (const r of input.resources) {
                let v, allowed, field;
                if (r.type === "aws:ec2/instance:Instance") {
                    v = read(r.props, "instanceType");
                    allowed = APPROVED.instanceFamilies[st];
                    field = "instanceType";
                } else if (r.type === "aws:rds/instance:Instance" && !g.ancestors(r).some((a) => a.type === "acme:db:Postgres")) {
                    // Platform databases are sized by postgres-size-by-stack.
                    v = read(r.props, "instanceClass");
                    allowed = APPROVED.dbClassFamilies[st];
                    field = "instanceClass";
                } else {
                    continue;
                }
                if (typeof v !== "string" || isUnknown(v)) {
                    continue;
                }
                const family = v.split(".").slice(0, -1).join(".");
                const size = v.split(".").pop();
                const tooBig = st === "dev" && sizes.indexOf(size) > sizes.indexOf(APPROVED.maxDevInstanceSize);
                if (allowed.indexOf(family) >= 0 && !tooBig) {
                    continue;
                }
                ctx.reportViolation(
                    `'${r.name}' at ${g.where(r)} uses \`${field}: "${v}"\`, but stack "${g.stackName}" allows the ` +
                        `${allowed.join(", ")} families${st === "dev" ? ` up to ${APPROVED.maxDevInstanceSize}` : ""}. ` +
                        `Choose it per stack, e.g. \`${field}: pulumi.getStack() === "prod" ? "${v}" : "${allowed[allowed.length - 1]}.small"\`.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "log-retention-by-stack",
        description: "Log groups set a retention of at least 7 days in dev and 90 in prod.",
        enforcementLevel: "mandatory",
        severity: "low",
        remediationSteps: "Set retentionInDays per stack.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const min = APPROVED.logRetentionDays[g.stackName === "prod" ? "prod" : "dev"];
            for (const r of input.resources) {
                if (r.type !== "aws:cloudwatch/logGroup:LogGroup") {
                    continue;
                }
                const days = read(r.props, "retentionInDays");
                if (isUnknown(days) || (typeof days === "number" && days >= min)) {
                    continue;
                }
                ctx.reportViolation(
                    `Log group '${r.name}' at ${g.where(r)} ${days === undefined ? "keeps logs forever (no retentionInDays)" : `keeps logs ${days} days`}; ` +
                        `stack "${g.stackName}" needs at least ${min}. Set \`retentionInDays: pulumi.getStack() === "prod" ? ` +
                        `${APPROVED.logRetentionDays.prod} : ${APPROVED.logRetentionDays.dev}\`.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "rds-backups-in-prod",
        description: "In prod, RDS instances keep backups for at least 7 days and have deletion protection on.",
        enforcementLevel: "mandatory",
        severity: "high",
        remediationSteps: "Set backupRetentionPeriod and deletionProtection (or use platform.db.Postgres, which does).",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx || g.stackName !== "prod") {
                return;
            }
            for (const r of input.resources) {
                if (r.type !== "aws:rds/instance:Instance" && r.type !== "aws:rds/cluster:Cluster") {
                    continue;
                }
                const days = read(r.props, "backupRetentionPeriod");
                const dp = read(r.props, "deletionProtection");
                const missing = [];
                if (!isUnknown(days) && !(typeof days === "number" && days >= APPROVED.rdsBackupDays)) {
                    missing.push(`\`backupRetentionPeriod: ${APPROVED.rdsBackupDays}\` (it is ${days === undefined ? "unset" : days})`);
                }
                if (!isUnknown(dp) && dp !== true) {
                    missing.push("`deletionProtection: true`");
                }
                if (missing.length === 0) {
                    continue;
                }
                const comp = g.ancestors(r).find((a) => a.type === "acme:db:Postgres");
                ctx.reportViolation(
                    `Database '${r.name}' at ${g.where(r)} needs ${missing.join(" and ")} in prod. ` +
                        (comp
                            ? `It is inside platform.db.Postgres '${comp.name}': fix the component in ${g.info(r).file}.`
                            : `Set them per stack (\`pulumi.getStack() === "prod"\`), or use \`platform.db.Postgres\`, which does.`),
                    r.urn,
                );
            }
        },
    },
    {
        name: "cost-estimate",
        description: "A rough monthly cost per team, from a small price table, stays within the team's budget (stack config teamBudgets).",
        enforcementLevel: "advisory",
        severity: "low",
        remediationSteps: "Downsize the top items for this stack, or raise the team's budget in Pulumi.<stack>.yaml.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const cfg = g.ctx.project.stackConfig[`${g.project}:teamBudgets`];
            const budgets = cfg && cfg.value;
            if (!budgets || typeof budgets !== "object") {
                return;
            }
            const P = APPROVED.prices;
            const items = {};
            for (const r of input.resources) {
                let price, what;
                if (r.type === "acme:db:Postgres") {
                    what = POSTGRES_CLASS[read(r.props, "size")];
                } else if (r.type === "aws:ec2/instance:Instance") {
                    what = read(r.props, "instanceType");
                } else if (r.type === "aws:rds/instance:Instance" && !g.ancestors(r).some((a) => a.type === "acme:db:Postgres")) {
                    what = read(r.props, "instanceClass");
                } else if (r.type === "aws:ec2/natGateway:NatGateway") {
                    what = "natGateway";
                } else if (r.type === "aws:lb/loadBalancer:LoadBalancer") {
                    what = "loadBalancer";
                }
                price = typeof what === "string" ? P[what] : undefined;
                if (price === undefined) {
                    continue;
                }
                const own = [r].concat(g.ancestors(r)).map((x) => g.teamOf(g.info(x).file)).find((t) => t);
                const team = own || "unowned";
                (items[team] = items[team] || []).push({ r, what, price });
            }
            for (const team of Object.keys(items).sort()) {
                const total = items[team].reduce((a, x) => a + x.price, 0);
                const budget = budgets[team];
                if (budget === undefined || total <= budget) {
                    continue;
                }
                const top = items[team]
                    .sort((a, b) => b.price - a.price)
                    .slice(0, 3)
                    .map((x) => `'${x.r.name}' ${x.what} ~$${x.price} (${g.where(x.r)})`)
                    .join(", ");
                ctx.reportViolation(
                    `Team ${team} would cost about $${Math.round(total)}/month in stack "${g.stackName}", over its ` +
                        `$${budget} budget. Top items: ${top}. Downsize them for this stack, or ask for a bigger budget ` +
                        `(\`${g.project}:teamBudgets\` in Pulumi.${g.stackName}.yaml). Rough list prices only.`,
                    g.at(`Pulumi.${g.stackName}.yaml`, 0),
                );
            }
        },
    },

    // ------------------------------------------------------------------------------------------------------------
    // Network, identity, shared infrastructure and blast radius
    // ------------------------------------------------------------------------------------------------------------
    {
        name: "shared-infra-ownership",
        description: "VPCs, subnets, NAT and internet gateways belong to the network team; KMS keys and DNS zones to the platform team.",
        enforcementLevel: "mandatory",
        severity: "high",
        remediationSteps: "Use the owning team's stack through a stack reference instead of creating your own.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            for (const r of input.resources) {
                const owner = APPROVED.sharedInfra[r.type];
                if (!owner || (g.info(r).file || "").startsWith(owner[0])) {
                    continue;
                }
                ctx.reportViolation(
                    `'${r.name}' at ${g.where(r)} creates a ${r.type.split(":").pop()}, which only ${owner[0]} may ` +
                        `create. Remove it and use ${owner[1]}.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "public-lb-via-service",
        description: "Internet-facing load balancers are created only through platform.network.Service.",
        enforcementLevel: "mandatory",
        severity: "high",
        remediationSteps: "Use `new platform.network.Service(name, { team, vpcId, port, publicSubnetIds }, { provider })`.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            for (const r of input.resources) {
                if (r.type !== "aws:lb/loadBalancer:LoadBalancer" && r.type !== "aws:alb/loadBalancer:LoadBalancer") {
                    continue;
                }
                if (read(r.props, "internal") === true || g.ancestors(r).some((a) => a.type === "acme:network:Service")) {
                    continue;
                }
                ctx.reportViolation(
                    `'${r.name}' at ${g.where(r)} is an internet-facing load balancer made by hand. Use ` +
                        `\`new platform.network.Service("${r.name}", { team, vpcId, port, publicSubnetIds }, { provider })\`: ` +
                        `it adds the security group, target group, logs and TLS defaults; read its \`.url\`.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "provider-region-allowed",
        description: "Every explicit AWS provider's region is one of the stack's allowed regions (config allowedRegions).",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Use platform.provider(team), which takes the stack's region, or an allowed region.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const cfg = g.ctx.project.stackConfig[`${g.project}:allowedRegions`];
            const allowed = cfg && Array.isArray(cfg.value) ? cfg.value : undefined;
            if (!allowed) {
                return;
            }
            for (const r of input.resources) {
                if (r.type !== "pulumi:providers:aws") {
                    continue;
                }
                const region = read(r.props, "region");
                if (typeof region !== "string" || isUnknown(region) || allowed.indexOf(region) >= 0) {
                    continue;
                }
                ctx.reportViolation(
                    `Provider '${r.name}' at ${g.where(r)} deploys to ${region}, but stack "${g.stackName}" allows ` +
                        `${allowed.join(", ")} (\`${g.project}:allowedRegions\`). Use \`${APPROVED.provider}\`, which ` +
                        `uses the stack's region; if you really need another region, ask to add it to allowedRegions.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "no-iam-users",
        description: "No IAM users, access keys or user policies: workloads and CI use roles.",
        enforcementLevel: "mandatory",
        severity: "high",
        remediationSteps: "Use platform.identity.Role (for CI: an OIDC role) instead of an IAM user.",
        kind: "resource",
        validate(input, ctx) {
            if (!/^aws:iam\/(user|accessKey|userPolicy|userPolicyAttachment|userLoginProfile|userGroupMembership):/.test(input.type)) {
                return;
            }
            ctx.reportViolation(
                `'${input.name}' is an IAM ${input.type.split(":").pop()}. IAM users mean long-lived keys. Use a role: ` +
                    `\`${APPROVED.components["acme:iam:Role"]}\`; CI assumes a role through OIDC, ask the platform team for it.`,
            );
        },
    },
    {
        name: "iam-least-privilege",
        description: "IAM policies don't allow `*` actions or resources, and attach only approved AWS managed policies.",
        enforcementLevel: "mandatory",
        severity: "critical",
        remediationSteps: "List the actions and resource ARNs the workload needs; attach only approved managed policies.",
        kind: "resource",
        validate(input, ctx) {
            const docs = [];
            if (/^aws:iam\/(rolePolicy|policy|userPolicy|groupPolicy):/.test(input.type)) {
                docs.push(["policy", read(input.props, "policy")]);
            }
            if (input.type === "aws:iam/role:Role") {
                const inline = read(input.props, "inlinePolicies");
                (Array.isArray(inline) ? inline : []).forEach((p, i) => docs.push([`inlinePolicies[${i}].policy`, read(p, "policy")]));
            }
            for (const [path, doc] of docs) {
                if (typeof doc !== "string" || isUnknown(doc)) {
                    continue;
                }
                let parsed;
                try {
                    parsed = JSON.parse(doc);
                } catch (e) {
                    continue;
                }
                const stmts = [].concat(parsed.Statement || []);
                const bad = stmts.filter((st) => st.Effect !== "Deny" && [].concat(st.Action || [], st.Resource || []).some((x) => x === "*"));
                if (bad.length > 0) {
                    ctx.reportViolation(
                        `'${input.name}' grants \`*\` in \`${path}\` (${bad.map((st) => `Action ${JSON.stringify(st.Action)} on ${JSON.stringify(st.Resource)}`).join("; ")}). ` +
                            `List the exact actions (e.g. "sqs:ReceiveMessage") and the resource ARNs, built from the ` +
                            `resources' \`.arn\` outputs with \`pulumi.jsonStringify\`.`,
                    );
                }
            }
            if (/^aws:iam\/(rolePolicyAttachment|policyAttachment|userPolicyAttachment|groupPolicyAttachment):/.test(input.type)) {
                const arn = read(input.props, "policyArn");
                if (typeof arn === "string" && !isUnknown(arn) && /^arn:aws:iam::aws:policy\//.test(arn) && APPROVED.managedPolicyArns.indexOf(arn) < 0) {
                    ctx.reportViolation(
                        `'${input.name}' attaches the AWS managed policy \`${arn}\`, which isn't approved. Approved: ` +
                            `${APPROVED.managedPolicyArns.map((a) => a.split("/").pop()).join(", ")}. Otherwise write a ` +
                            `policy with the exact actions and resources this workload needs.`,
                    );
                }
            }
        },
    },
    {
        name: "role-permission-boundary",
        description: "IAM roles set the company permission boundary; platform.identity.Role does it for you.",
        enforcementLevel: "mandatory",
        severity: "high",
        remediationSteps: "Use platform.identity.Role instead of aws.iam.Role.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            for (const r of input.resources) {
                if (r.type !== "aws:iam/role:Role" || g.ancestors(r).some((a) => a.type === "acme:iam:Role")) {
                    continue;
                }
                if (read(r.props, "permissionsBoundary") !== undefined) {
                    continue;
                }
                const team = g.teamOf(g.info(r).file);
                ctx.reportViolation(
                    `Role '${r.name}' at ${g.where(r)} has no permission boundary. Use \`new platform.identity.Role("${r.name}", ` +
                        `{ team: "${team || "<team>"}", service: "<service>.amazonaws.com", managedPolicyArns: [...] }, { provider })\`, ` +
                        `which sets the boundary from the platform stack; read \`.arn\` and \`.name\` as before.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "allowed-locations",
        description: "Resources are declared only under src/<team>/ or platform/ (index.ts wires modules).",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Move the resource into the owning team's directory.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            for (const r of input.resources) {
                const f = g.info(r).file;
                if (!f || /^(src\/[^/]+\/|platform\/)/.test(f) || /^index\.[jt]s$/.test(f) || r.type.startsWith("pulumi:")) {
                    continue;
                }
                ctx.reportViolation(
                    `'${r.name}' is declared in ${g.where(r)}, outside src/<team>/ and platform/, so no team owns it. ` +
                        `Move it into the owning team's directory (src/<team>/...) and export it from there.`,
                    r.urn,
                );
            }
        },
    },
    {
        name: "forbidden-resource-types",
        description: "App stacks don't create organization- or account-level resources.",
        enforcementLevel: "mandatory",
        severity: "high",
        remediationSteps: "Remove the resource; account-level settings are managed by the platform team.",
        kind: "resource",
        validate(input, ctx) {
            const hit = APPROVED.forbiddenTypes.find((t) => input.type.startsWith(t));
            if (hit) {
                ctx.reportViolation(
                    `'${input.name}' is a ${input.type}: organization and account settings (${APPROVED.forbiddenTypes.join(", ")}) ` +
                        `are owned by the platform team, and changing them affects every stack in the account. Remove it ` +
                        `and ask the platform team.`,
                );
            }
        },
    },
    {
        name: "security-review",
        description: "IAM and network resources declared in app code are flagged for a security review (advisory).",
        enforcementLevel: "advisory",
        severity: "low",
        remediationSteps: "No change needed; a reviewer from security looks at these. Prefer platform components.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            const re = /^aws:(iam\/|ec2\/(securityGroup|securityGroupRule|vpc|internetGateway|natGateway|vpcPeeringConnection|networkAcl)|vpc\/securityGroup|lb\/loadBalancer|alb\/loadBalancer)/;
            for (const r of input.resources) {
                if (!re.test(r.type) || insidePlatform(g, r)) {
                    continue;
                }
                ctx.reportViolation(
                    `'${r.name}' (${r.type.split(":").pop()}) at ${g.where(r)} changes identity or network access: a ` +
                        `security reviewer will look at it. Platform components (platform.identity.Role, ` +
                        `platform.network.Service) don't need this review.`,
                    r.urn,
                );
            }
        },
    },

    // ------------------------------------------------------------------------------------------------------------
    // Definition of done, outputs and determinism
    // ------------------------------------------------------------------------------------------------------------
    {
        name: "service-definition-of-done",
        description: "Every service (platform.network.Service or Lambda function) has an alarm and a log group with retention.",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Add an aws.cloudwatch.MetricAlarm and a LogGroup with retentionInDays that reference the service.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            const kids = {};
            input.resources.forEach((r) => r.parent && (kids[r.parent] = kids[r.parent] || []).push(r));
            const subtree = (r) => {
                const out = new Set([r.urn]);
                const walk = (x) => (kids[x.urn] || []).forEach((k) => (out.add(k.urn), walk(k)));
                walk(r);
                return out;
            };
            const refs = (x) => {
                const out = [x.parent].concat(x.dependencies || []);
                Object.keys(x.propertyDependencies || {}).forEach((k) => out.push(...x.propertyDependencies[k]));
                return out;
            };
            for (const r of input.resources) {
                const isService = r.type === "acme:network:Service" || (r.type === "aws:lambda/function:Function" && !insidePlatform(g, r));
                if (!isService) {
                    continue;
                }
                const mine = subtree(r);
                const linked = (x) => mine.has(x.urn) || refs(x).some((u) => mine.has(u));
                const missing = [];
                if (!input.resources.some((x) => x.type === "aws:cloudwatch/metricAlarm:MetricAlarm" && linked(x))) {
                    missing.push(
                        r.type === "acme:network:Service"
                            ? `an alarm: \`new aws.cloudwatch.MetricAlarm("${r.name}-5xx", { namespace: "AWS/ApplicationELB", metricName: "HTTPCode_Target_5XX_Count", dimensions: { TargetGroup: ${r.name.replace(/-./g, (m) => m[1].toUpperCase())}.targetGroupArnSuffix }, ... }, { provider })\``
                            : `an alarm: \`new aws.cloudwatch.MetricAlarm("${r.name}-errors", { namespace: "AWS/Lambda", metricName: "Errors", dimensions: { FunctionName: fn.name }, ... }, { provider })\``,
                    );
                }
                const logs = input.resources.filter((x) => x.type === "aws:cloudwatch/logGroup:LogGroup" && linked(x));
                if (!logs.some((x) => typeof read(x.props, "retentionInDays") === "number")) {
                    missing.push(
                        r.type === "acme:network:Service"
                            ? "a log group with retention (the component creates one; don't remove it)"
                            : `a log group with retention: \`new aws.cloudwatch.LogGroup("${r.name}-logs", { name: pulumi.interpolate\`/aws/lambda/\${fn.name}\`, retentionInDays: pulumi.getStack() === "prod" ? 90 : 14 }, { provider })\``,
                    );
                }
                if (missing.length > 0) {
                    ctx.reportViolation(
                        `Service '${r.name}' at ${g.where(r)} isn't done: it needs ${missing.join(", and ")}. Every ` +
                            `service ships with an alarm and logs that expire.`,
                        r.urn,
                    );
                }
            }
        },
    },
    {
        name: "required-stack-outputs",
        description: "The program exports every stack output listed in the project config requiredOutputs.",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Export the missing outputs from index.ts.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            const key = `${g.project}:requiredOutputs`;
            const sc = g.ctx.project.stackConfig[key];
            const decl = g.ctx.project.config[key];
            const required = (sc && sc.value) || (decl && decl.default);
            if (!Array.isArray(required)) {
                return;
            }
            const have = g.ctx.program.outputs.map((o) => o.name);
            const missing = required.filter((n) => have.indexOf(n) < 0);
            if (missing.length > 0) {
                const entry = (g.ctx.project.main || g.ctx.program.packageJson.main || "index.ts").replace(/^\.\//, "");
                ctx.reportViolation(
                    `The stack doesn't export ${missing.map((n) => `\`${n}\``).join(", ")}, which other stacks and tools ` +
                        `depend on (\`requiredOutputs\` in Pulumi.yaml). Export ${missing.length > 1 ? "them" : "it"} from ` +
                        `${entry}, e.g. \`export const ${missing[0]} = <team module>.<resource>.<output>;\`.`,
                    g.at(entry, 0),
                );
            }
        },
    },
    {
        name: "deterministic-names",
        description: "The program doesn't use Date.now(), Math.random() or crypto.randomUUID(): every run must declare the same resources.",
        enforcementLevel: "mandatory",
        severity: "medium",
        remediationSteps: "Use a fixed name, or a random.RandomId/RandomString resource.",
        kind: "stack",
        validate(input, ctx) {
            const g = graph(input.resources);
            if (!g.ctx) {
                return;
            }
            for (const c of g.ctx.program.nondeterminism || []) {
                ctx.reportViolation(
                    `${c.file}:${c.line} calls ${c.call}, which gives a different value on every run, so a name or ` +
                        `input built from it differs every time the program runs. Use a fixed name (Pulumi auto-names ` +
                        `physical names for you), or a \`random.RandomId\` resource (@pulumi/random).`,
                    g.at(c.file, c.line),
                );
            }
        },
    },
];

globalThis.__pulumiPolicyPack = {
    abiVersion: 1,
    name: "acme-guardrails",
    version: "0.1.0",
    description: "Acme guardrails: golden-path components, conventions and Pulumi best practices.",
    policies,
};
