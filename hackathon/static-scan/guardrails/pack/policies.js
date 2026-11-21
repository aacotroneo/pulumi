// Acme guardrails: a hand-written purejs policy pack (one file, no build step) for `pulumi policy scan`.
//
// Policies here say only what the rule is. The framework at the top of the file does the rest: walking the resource
// graph, reading the scan context, decoding provider inputs, handling values only a deployment knows, and placing
// findings on lines of code. It is a shim over ABI v1 (every policy becomes one v1 stack policy), so the pack runs on
// the lean purejs host unchanged.

// =====================================================================================================================
// Framework: moves into the pack runtime later. Policies use only what it passes in (`r`, `ctx`).
// =====================================================================================================================
//
//   policy({ name, description, enforcementLevel, severity, remediationSteps,
//            resourceTypes: ["aws:s3/bucket:Bucket", "aws:iam/*", "*"],  // exact types, or prefix globs ending in *
//            validate(r, ctx) { ... } })      // once per matching resource, with the whole program in ctx
//   policy({ name, ..., validate(ctx) { ... } })   // no resourceTypes: once per program
//
// r:   type, name, urn, props, parent, dependencies, propertyDependencies, plus the scan context's file, line,
//      column, custom, remote, read, provider (URN), version, options, secretInputs, createdInApply. Provider inputs
//      come JSON-decoded.
// ctx: stack, project {name, description, config, stackConfig}, program {imports, configRead, sideEffects,
//      nondeterminism, outputs, packageJson, localPackages, ...}; config(key);
//      resources(type?), get(urn), parent(r), children(r), descendants(r), ancestors(r), within(r, typeOrResource),
//      references(r, output?), referencedBy(r, output?), providerOf(r); strings(value), parseJSON(text);
//      reportViolation(message, where?), where is a resource or anything with file (and line); default: r, or the
//      program.
//
// Unknowns. A value only a deployment knows (another resource's output, or text built from one) is an opaque
// Unknown: the same output is the same object everywhere, so `===` joins between resources work. Using it in any
// other way (string conversion, property access, JSON) stops the policy for that resource, and the finding is
// "can't run policy ... before deployment". Policies never check for unknowns.

const STACK_TYPE = "pulumi:pulumi:Stack";
const REF = /output-([0-9a-f]{16})\.([A-Za-z0-9_]+)/g;
const WHOLE_REF = /^output-([0-9a-f]{16})\.([A-Za-z0-9_]+)$/;

class UnknownValue extends Error {
    constructor(what) {
        super(`uses ${what}, which is unknown until deployment`);
        this.name = "UnknownValue";
        this.what = what;
    }
}

const unknowns = new WeakMap(); // the proxy -> {what, refs}
function makeUnknown(what, refs) {
    const target = Object.freeze({});
    const fail = () => {
        throw new UnknownValue(what);
    };
    const u = new Proxy(target, {
        get: fail,
        has: fail,
        ownKeys: fail,
        getOwnPropertyDescriptor: fail,
        set: fail,
        defineProperty: fail,
        deleteProperty: fail,
    });
    unknowns.set(u, { what, refs });
    return u;
}

// One program model per AnalyzeStack call (the host passes every stack policy the same input).
const models = new WeakMap();

function buildModel(input) {
    const raw = input.resources;
    const stackRes = raw.find((r) => r.type === STACK_TYPE);
    let scan = {};
    try {
        scan = (stackRes && stackRes.props.scan) || {};
    } catch (e) {
        scan = {};
    }
    const info = scan.resources || {};
    // Name the outputs: every resource's `id` (and `arn`) is "output-<hash of its URN>.id" in stack policies.
    const ownerOfHash = {};
    for (const r of raw) {
        for (const k of ["id", "arn"]) {
            let v;
            try {
                v = r.props[k];
            } catch (e) {
                continue;
            }
            const m = typeof v === "string" && WHOLE_REF.exec(v);
            if (m) {
                ownerOfHash[m[1]] = r;
            }
        }
    }
    const interned = {};
    const describeRef = (hash, prop) => `<output ${ownerOfHash[hash] ? ownerOfHash[hash].name : "?"}.${prop}>`;
    const fromString = (s) => {
        if (s.indexOf("output-") < 0) {
            return s;
        }
        const refs = [];
        const text = s.replace(REF, (_, hash, prop) => {
            refs.push({ hash, prop });
            return describeRef(hash, prop);
        });
        if (refs.length === 0) {
            return s;
        }
        if (!interned[s]) {
            const whole = WHOLE_REF.exec(s);
            interned[s] = makeUnknown(whole ? text : `a value built from ${refs.map((x) => describeRef(x.hash, x.prop)).join(", ")}`, refs);
        }
        return interned[s];
    };
    const convert = (v, label) => {
        if (typeof v === "string") {
            return fromString(v);
        }
        if (Array.isArray(v)) {
            // By index: an element only a deployment knows throws when read.
            const out = [];
            for (let i = 0; i < v.length; i++) {
                out.push(readSafe(v, i, `${label}[${i}]`));
            }
            return out;
        }
        if (v && typeof v === "object") {
            const out = {};
            for (const k of Object.keys(v)) {
                out[k] = readSafe(v, k, `${label}.${k}`);
            }
            return out;
        }
        return v;
    };
    const readSafe = (obj, k, label) => {
        let v;
        try {
            v = obj[k];
        } catch (e) {
            return makeUnknown(`<unknown ${label}>`, []);
        }
        return convert(v, label);
    };

    const resources = [];
    const byUrn = {};
    for (const h of raw) {
        if (h.type === STACK_TYPE) {
            continue;
        }
        const props = {};
        for (const k of Object.keys(h.props)) {
            let v = readSafe(h.props, k, `${h.name}.${k}`);
            // Provider inputs reach policies JSON-encoded ("defaultTags": "{...}").
            if (h.type.startsWith("pulumi:providers:") && typeof v === "string" && /^[[{]/.test(v)) {
                try {
                    v = convert(JSON.parse(v), `${h.name}.${k}`);
                } catch (e) {
                    // Not JSON after all: keep the text.
                }
            }
            props[k] = v;
        }
        const r = Object.assign({}, info[h.urn] || {}, {
            type: h.type,
            name: h.name,
            urn: h.urn,
            props,
            parent: h.parent,
            dependencies: h.dependencies || [],
            propertyDependencies: h.propertyDependencies || {},
        });
        r.options = r.options || {};
        r.secretInputs = r.secretInputs || [];
        resources.push(r);
        byUrn[r.urn] = r;
    }

    // Who refers to whom: dependencies, property dependencies, and values equal to (or built from) another
    // resource's output.
    const refsOf = new Map();
    const collect = (v, out) => {
        const u = v !== null && typeof v === "object" ? unknowns.get(v) : undefined;
        if (u) {
            u.refs.forEach((x) => ownerOfHash[x.hash] && out.push({ to: byUrn[ownerOfHash[x.hash].urn], output: x.prop }));
        } else if (Array.isArray(v)) {
            v.forEach((e) => collect(e, out));
        } else if (v && typeof v === "object") {
            Object.keys(v).forEach((k) => collect(v[k], out));
        }
    };
    for (const r of resources) {
        const out = [];
        r.dependencies.forEach((u) => byUrn[u] && out.push({ to: byUrn[u], output: undefined }));
        Object.keys(r.propertyDependencies).forEach((k) =>
            r.propertyDependencies[k].forEach((u) => byUrn[u] && out.push({ to: byUrn[u], output: undefined })),
        );
        for (const k of Object.keys(r.props)) {
            // A resource's own id and arn are itself.
            if (k !== "id" && k !== "arn") {
                collect(r.props[k], out);
            }
        }
        refsOf.set(r, out.filter((x) => x.to && x.to !== r));
    }

    return { scan, stackUrn: stackRes ? stackRes.urn : "", resources, byUrn, refsOf };
}

function typeMatcher(patterns) {
    const list = [].concat(patterns);
    return (type) => list.some((p) => p === "*" || p === type || (p.endsWith("*") && type.startsWith(p.slice(0, -1))));
}

function makeContext(m, report) {
    const unique = (xs) => xs.filter((x, i) => xs.indexOf(x) === i);
    // Without a scan context (an older CLI, or a program that didn't finish), everything reads as empty.
    const project = Object.assign({ name: "", config: {}, stackConfig: {} }, m.scan.project);
    const program = Object.assign(
        { imports: [], configRead: [], sideEffects: [], nondeterminism: [], outputs: [], invokes: [], stackReferences: [],
          files: [], localPackages: {}, packageJson: { dependencies: {}, devDependencies: {} } },
        m.scan.program,
    );
    const ctx = {
        stack: m.scan.stack,
        project,
        program,
        // A project config value: the stack's (plain values only), else Pulumi.yaml's default.
        config(key) {
            const full = key.indexOf(":") >= 0 ? key : `${ctx.project.name}:${key}`;
            const s = ctx.project.stackConfig[full];
            if (s && !s.secure && s.value !== undefined) {
                return s.value;
            }
            const d = ctx.project.config[full];
            return d ? d.default : undefined;
        },
        resources: (type) => (type ? m.resources.filter((r) => typeMatcher(type)(r.type)) : m.resources.slice()),
        get: (urn) => m.byUrn[urn],
        parent: (r) => m.byUrn[r.parent],
        children: (r) => m.resources.filter((x) => x.parent === r.urn),
        descendants(r) {
            const out = [];
            const walk = (x) => ctx.children(x).forEach((k) => (out.push(k), walk(k)));
            walk(r);
            return out;
        },
        ancestors(r) {
            const out = [];
            for (let p = m.byUrn[r.parent]; p; p = m.byUrn[p.parent]) {
                out.push(p);
            }
            return out;
        },
        // The nearest ancestor that is the given resource, or has the given type (or one of the given types).
        within(r, what) {
            const match = what && what.urn ? (a) => a === what : (a) => typeMatcher(what)(a.type);
            return ctx.ancestors(r).find(match);
        },
        // The resources r refers to; with `output`, only through that output's value (e.g. "id").
        references: (r, output) =>
            unique(m.refsOf.get(r).filter((x) => output === undefined || x.output === output).map((x) => x.to)),
        referencedBy: (r, output) => m.resources.filter((x) => ctx.references(x, output).indexOf(r) >= 0),
        providerOf: (r) => m.byUrn[r.provider],
        // Every known string in a value, as [path, text]; values only a deployment knows are left out.
        strings(v, path) {
            const out = [];
            const walk = (x, p) => {
                if (typeof x === "string") {
                    out.push([p, x]);
                } else if (x !== null && typeof x === "object" && !unknowns.has(x)) {
                    Object.keys(x).forEach((k) => walk(x[k], p ? `${p}.${k}` : k));
                }
            };
            walk(v, path || "");
            return out;
        },
        // JSON text to a value, or undefined if it isn't JSON.
        parseJSON(text) {
            if (text !== null && typeof text === "object" && unknowns.has(text)) {
                throw new UnknownValue(unknowns.get(text).what);
            }
            if (typeof text !== "string") {
                return undefined;
            }
            try {
                return JSON.parse(text);
            } catch (e) {
                return undefined;
            }
        },
        reportViolation: report,
    };
    return ctx;
}

const policyList = [];
const authored = [];

function policy(def) {
    authored.push(def);
    const perResource = def.resourceTypes !== undefined;
    const matches = perResource ? typeMatcher(def.resourceTypes) : undefined;
    policyList.push({
        name: def.name,
        description: def.description,
        enforcementLevel: def.enforcementLevel,
        severity: def.severity,
        remediationSteps: def.remediationSteps,
        kind: "stack",
        validate(input, host) {
            if (!models.has(input)) {
                models.set(input, buildModel(input));
            }
            const m = models.get(input);
            const run = (r) => {
                const found = [];
                const report = (message, where) => {
                    let urn;
                    if (where === undefined) {
                        urn = r ? r.urn : m.stackUrn;
                    } else if (where.urn && m.byUrn[where.urn]) {
                        urn = where.urn;
                    } else if (where.file) {
                        // A line of code that isn't a resource's: the scan places `<stack urn>#<file>:<line>` there.
                        urn = `${m.stackUrn}#${where.file}:${where.line || 0}`;
                    } else {
                        throw new Error(`${def.name}: reportViolation's 'where' must be a resource or have a file`);
                    }
                    found.push([String(message), urn]);
                };
                const ctx = makeContext(m, report);
                try {
                    if (r) {
                        def.validate(r, ctx);
                    } else {
                        def.validate(ctx);
                    }
                } catch (e) {
                    if (!(e instanceof UnknownValue)) {
                        throw e;
                    }
                    host.reportViolation(
                        {
                            message: `can't run policy '${def.name}' before deployment: ${r ? `'${r.name}' ` : "the program "}${e.message}`,
                            enforcementLevel: "advisory",
                        },
                        r ? r.urn : m.stackUrn,
                    );
                    return;
                }
                found.forEach(([msg, urn]) => host.reportViolation(msg, urn));
            };
            if (perResource) {
                m.resources.filter((r) => matches(r.type)).forEach(run);
            } else {
                run(undefined);
            }
        },
    });
}

// =====================================================================================================================
// Pack: the approved choices, and the policies.
// =====================================================================================================================

// The approved choices, in one place: the policies enforce them, and agent-rules.js turns them into instructions.
const APPROVED = {
    components: {
        "acme:storage:Bucket": 'new platform.storage.Bucket(name, { team, dataClass: "public" | "internal" | "confidential" }, { provider })',
        "acme:db:Postgres": "new platform.db.Postgres(name, { team, size, password: config.requireSecret(key) }, { provider, protect: isProd })",
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
    // Type -> [the directory that may create it, what to use instead].
    sharedInfra: {
        "aws:ec2/vpc:Vpc": ["src/network/", "the network stack's vpcId output, through a stack reference"],
        "aws:ec2/subnet:Subnet": ["src/network/", "the network stack's subnet outputs"],
        "aws:ec2/natGateway:NatGateway": ["src/network/", "the network stack's private subnets, which already route through NAT"],
        "aws:ec2/internetGateway:InternetGateway": ["src/network/", "the network stack's public subnets"],
        "aws:kms/key:Key": ["platform/", "the platform stack's keys, or a platform component that encrypts for you"],
        "aws:route53/zone:Zone": ["platform/", "the platform stack's zones"],
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

// The pack's own vocabulary.
const PLATFORM_COMPONENTS = ["acme:storage:Bucket", "acme:db:Postgres", "acme:network:Service", "acme:iam:Role"];
const POSTGRES_CLASS = { small: "db.t4g.small", medium: "db.r6g.large", large: "db.r6g.2xlarge" };
const teamOf = (file) => (/^src\/([^/]+)\//.exec(file || "") || [])[1];
const isProvider = (r) => r.type.startsWith("pulumi:providers:");
const short = (type) => type.split(":").pop();
const stackKind = (ctx) => (ctx.stack === "prod" ? "prod" : "dev");
const entryFile = (ctx) => (ctx.project.main || ctx.program.packageJson.main || "index.ts").replace(/^\.\//, "");

// ---------------------------------------------------------------------------------------------------------------------
// Golden paths and components
// ---------------------------------------------------------------------------------------------------------------------

policy({
    name: "use-platform-bucket",
    description: "S3 buckets are created with the @acme/platform storage component, not the raw AWS resource.",
    enforcementLevel: "mandatory",
    severity: "high",
    remediationSteps: "Replace the raw bucket with `new platform.storage.Bucket(name, { team, dataClass }, { provider })`.",
    resourceTypes: ["aws:s3/bucket:Bucket", "aws:s3/bucketV2:BucketV2"],
    validate(r, ctx) {
        if (!ctx.within(r, "acme:storage:Bucket")) {
            ctx.reportViolation(
                "Use platform.storage.Bucket instead of a raw S3 bucket; it adds encryption, versioning, a public access block and tags.",
            );
        }
    },
});

policy({
    name: "use-platform-database",
    description: "Databases are created with the @acme/platform Postgres component, not raw RDS resources.",
    enforcementLevel: "mandatory",
    severity: "high",
    remediationSteps: "Replace the raw RDS resource with `new platform.db.Postgres(name, { team, size, password }, { provider })`.",
    resourceTypes: ["aws:rds/instance:Instance", "aws:rds/cluster:Cluster"],
    validate(r, ctx) {
        if (!ctx.within(r, "acme:db:Postgres")) {
            ctx.reportViolation(
                "Use platform.db.Postgres instead of a raw RDS database; it is private, encrypted and backed up. Read replicas aren't offered yet: ask the platform team.",
            );
        }
    },
});

policy({
    name: "approved-platform-modules",
    description: "Only supported @acme/platform modules and components are used; deprecated ones are not.",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Import from `@acme/platform` and use its supported components.",
    validate(ctx) {
        const deprecated = { "@acme/platform/legacy": "deprecated since @acme/platform 2.0" };
        const replacements = { "acme:legacy:Queue": "a plain SQS queue with the team provider (the platform has no queue component yet)" };
        for (const imp of ctx.program.imports) {
            if (deprecated[imp.module] && !imp.file.startsWith("platform/")) {
                ctx.reportViolation(`${imp.module} is ${deprecated[imp.module]}; use the supported components from @acme/platform.`, imp);
            }
        }
        for (const r of ctx.resources("acme:*")) {
            if (PLATFORM_COMPONENTS.indexOf(r.type) < 0) {
                ctx.reportViolation(`${r.type} isn't a supported platform component; use ${replacements[r.type] || PLATFORM_COMPONENTS.join(", ")}.`, r);
            }
        }
        const platform = ctx.program.localPackages["@acme/platform"];
        if (platform && platform.version && parseInt(platform.version, 10) < 2) {
            ctx.reportViolation(`@acme/platform ${platform.version} is too old; version 2 or later is required.`);
        }
    },
});

policy({
    name: "postgres-size-by-stack",
    description: "Platform databases use the sizes allowed for the stack: small in dev, medium or large in prod.",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Pick a size allowed in this stack, per stack (config), not one size for all stacks.",
    resourceTypes: ["acme:db:Postgres"],
    validate(r, ctx) {
        const allowed = APPROVED.postgresSizes[ctx.stack] || APPROVED.postgresSizes.other;
        if (allowed.indexOf(r.props.size) < 0) {
            ctx.reportViolation(
                `Size "${r.props.size}" isn't allowed in stack ${ctx.stack}, which takes ${allowed.join(" or ")}; choose the size per stack, in its config or by stack name.`,
            );
        }
    },
});

policy({
    name: "bucket-component-invariants",
    description: "Every acme:storage:Bucket has a public access block, versioning and server-side encryption.",
    enforcementLevel: "mandatory",
    severity: "high",
    remediationSteps: "Fix the component in @acme/platform so every instance gets all three children.",
    resourceTypes: ["acme:storage:Bucket"],
    validate(r, ctx) {
        const kids = ctx.children(r);
        const has = (type, ok) => kids.some((k) => k.type === type && ok(k.props));
        const missing = [];
        const flags = ["blockPublicAcls", "blockPublicPolicy", "ignorePublicAcls", "restrictPublicBuckets"];
        if (!has("aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock", (p) => flags.every((f) => p[f] === true))) {
            missing.push("public access block");
        }
        if (!has("aws:s3/bucketVersioning:BucketVersioning", (p) => (p.versioningConfiguration || {}).status === "Enabled")) {
            missing.push("versioning");
        }
        if (!has("aws:s3/bucketServerSideEncryptionConfiguration:BucketServerSideEncryptionConfiguration", () => true)) {
            missing.push("server-side encryption");
        }
        if (missing.length > 0) {
            const impl = kids.map((k) => k.file).find((f) => f) || "@acme/platform";
            ctx.reportViolation(
                `This ${r.props.dataClass} bucket has no ${missing.join(" or ")}; that's a bug in the platform's Bucket component (${impl}), not in this code.`,
            );
        }
    },
});

policy({
    name: "component-encapsulation",
    description: "Code outside a platform component doesn't attach resources to the component's internals.",
    enforcementLevel: "mandatory",
    severity: "high",
    remediationSteps: "Use the component's own methods or inputs instead of attaching to its children.",
    resourceTypes: ["*"],
    validate(r, ctx) {
        const api = { "acme:network:Service": "its allowFrom method (private CIDRs only)" };
        // Attaching goes by the child's id; an arn is often an output the component exposes on purpose.
        for (const child of ctx.references(r, "id")) {
            const comp = ctx.within(child, PLATFORM_COMPONENTS);
            if (comp && !ctx.within(r, comp)) {
                ctx.reportViolation(
                    `This attaches to ${child.name}, inside ${comp.type} ${comp.name}; use ${api[comp.type] || "the component's inputs"} instead of changing its internals.`,
                );
                return;
            }
        }
    },
});

// ---------------------------------------------------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------------------------------------------------

policy({
    name: "kebab-case-names",
    description: "Logical resource names are kebab-case.",
    enforcementLevel: "mandatory",
    severity: "low",
    remediationSteps: "Rename the resource to its kebab-case form.",
    resourceTypes: ["*"],
    validate(r, ctx) {
        if (r.type.startsWith("pulumi:pulumi:") || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.name)) {
            return;
        }
        const kebab = r.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
        ctx.reportViolation(`Rename '${r.name}' to '${kebab}': logical names are kebab-case.`);
    },
});

policy({
    name: "physical-name-prefix",
    description: "Explicit physical names start with <project>-<stack>-; otherwise leave them out for auto-naming.",
    enforcementLevel: "mandatory",
    severity: "low",
    remediationSteps: "Remove the explicit name, or prefix it with `${pulumi.getProject()}-${pulumi.getStack()}-`.",
    resourceTypes: ["*"],
    validate(r, ctx) {
        if (!r.custom || isProvider(r) || r.read || ctx.within(r, "acme:*")) {
            return;
        }
        const prefix = `${ctx.project.name}-${ctx.stack}-`;
        for (const f of ["name", "bucket", "identifier"]) {
            const v = r.props[f];
            if (typeof v === "string" && !v.startsWith(prefix)) {
                ctx.reportViolation(`The physical name "${v}" will collide across stacks; leave ${f} out so Pulumi auto-names it, or start it with ${prefix}.`);
            }
        }
    },
});

policy({
    name: "deterministic-names",
    description: "The program doesn't use Date.now(), Math.random() or crypto.randomUUID(): every run must declare the same resources.",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Use a fixed name, or a random.RandomId/RandomString resource.",
    validate(ctx) {
        for (const c of ctx.program.nondeterminism) {
            ctx.reportViolation(
                `${c.call} gives a different value on every run, so names or inputs built from it change on every update; use a fixed name or a random.RandomId resource.`,
                c,
            );
        }
    },
});

// ---------------------------------------------------------------------------------------------------------------------
// Code, files and blast radius
// ---------------------------------------------------------------------------------------------------------------------

policy({
    name: "team-ownership",
    description: "Resources declared under src/<team>/ belong to that team (component `team` input, or a team tag).",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Set the team to the directory's team, or move the code to the owning team's directory.",
    resourceTypes: ["*"],
    validate(r, ctx) {
        const team = teamOf(r.file);
        if (!team || isProvider(r) || r.read || r.type.startsWith("pulumi:")) {
            return;
        }
        let found = r.custom ? (r.props.tags || {}).team : r.props.team;
        let how = r.custom ? "its team tag" : "its team input";
        const provider = ctx.providerOf(r);
        if (r.custom && found === undefined && provider) {
            found = ((provider.props.defaultTags || {}).tags || {}).team;
            how = "its provider's default team tag";
        }
        if (found === undefined) {
            ctx.reportViolation(`Nothing marks this as ${team}'s, though it's in src/${team}/; use the ${team} team provider (it sets the team tag) or tag it team=${team}.`);
        } else if (found !== team) {
            ctx.reportViolation(`It's in src/${team}/ but ${how} says "${found}"; set it to "${team}", or move it to src/${found}/.`);
        }
    },
});

policy({
    name: "no-resources-in-entrypoint",
    description: "The entry point (index.ts) only wires team modules together; it declares no resources.",
    enforcementLevel: "advisory",
    severity: "low",
    remediationSteps: "Move the resource into the owning team's module and export what index.ts needs.",
    resourceTypes: ["*"],
    validate(r, ctx) {
        if ([entryFile(ctx), "index.ts", "index.js"].indexOf(r.file) >= 0 && !isProvider(r) && !r.type.startsWith("pulumi:")) {
            ctx.reportViolation("The entry point only wires modules together; declare this in the owning team's module under src/<team>/ and export it from there.");
        }
    },
});

policy({
    name: "allowed-locations",
    description: "Resources are declared only under src/<team>/ or platform/ (index.ts wires modules).",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Move the resource into the owning team's directory.",
    resourceTypes: ["*"],
    validate(r, ctx) {
        if (r.file && !/^(src\/[^/]+\/|platform\/)/.test(r.file) && !/^index\.[jt]s$/.test(r.file) && !r.type.startsWith("pulumi:")) {
            ctx.reportViolation(`${r.file} is outside src/<team>/ and platform/, so no team owns this; move it into the owning team's directory.`);
        }
    },
});

policy({
    name: "forbidden-resource-types",
    description: "App stacks don't create organization- or account-level resources.",
    enforcementLevel: "mandatory",
    severity: "high",
    remediationSteps: "Remove the resource; account-level settings are managed by the platform team.",
    resourceTypes: APPROVED.forbiddenTypes.map((t) => `${t}*`),
    validate(r, ctx) {
        ctx.reportViolation(`${short(r.type)} is an account-level setting that affects every stack in the account; remove it and ask the platform team.`);
    },
});

policy({
    name: "no-resources-in-apply",
    description: "Resources are not created inside apply callbacks.",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Create the resource at the top level and pass the Output as its input.",
    resourceTypes: ["*"],
    validate(r, ctx) {
        if (r.createdInApply) {
            ctx.reportViolation("This is created inside an apply callback, so previews can't show it reliably; create it at the top level and pass the Output as its input.");
        }
    },
});

policy({
    name: "hermetic-program",
    description: "The program doesn't run processes or reach the network while it deploys.",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Pass the value in through stack config instead of computing it at deploy time.",
    validate(ctx) {
        for (const s of ctx.program.sideEffects) {
            const what = s.kind === "process" ? `Running "${s.target}"` : `Calling ${s.kind} ${s.target}`;
            ctx.reportViolation(`${what} at deploy time gives different results on laptops, CI and Deployments; pass the value in as stack config instead.`, s);
        }
    },
});

// ---------------------------------------------------------------------------------------------------------------------
// Size, retention and cost per stack
// ---------------------------------------------------------------------------------------------------------------------

policy({
    name: "instance-types-by-stack",
    description: "EC2 instance types and RDS classes come from the families allowed in the stack (burstable in dev).",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Pick an allowed family for this stack, per stack.",
    resourceTypes: ["aws:ec2/instance:Instance", "aws:rds/instance:Instance"],
    validate(r, ctx) {
        // Platform databases are sized by postgres-size-by-stack.
        if (ctx.within(r, "acme:db:Postgres")) {
            return;
        }
        const st = stackKind(ctx);
        const ec2 = r.type === "aws:ec2/instance:Instance";
        const v = ec2 ? r.props.instanceType : r.props.instanceClass;
        if (typeof v !== "string") {
            return;
        }
        const allowed = ec2 ? APPROVED.instanceFamilies[st] : APPROVED.dbClassFamilies[st];
        const sizes = ["nano", "micro", "small", "medium", "large", "xlarge"];
        const family = v.split(".").slice(0, -1).join(".");
        const tooBig = st === "dev" && sizes.indexOf(v.split(".").pop()) > sizes.indexOf(APPROVED.maxDevInstanceSize);
        if (allowed.indexOf(family) < 0 || tooBig) {
            ctx.reportViolation(
                `${v} isn't allowed in stack ${ctx.stack}, which takes the ${allowed.join(", ")} families${st === "dev" ? ` up to ${APPROVED.maxDevInstanceSize}` : ""}; choose the type per stack.`,
            );
        }
    },
});

policy({
    name: "log-retention-by-stack",
    description: "Log groups set a retention of at least 7 days in dev and 90 in prod.",
    enforcementLevel: "mandatory",
    severity: "low",
    remediationSteps: "Set retentionInDays per stack.",
    resourceTypes: ["aws:cloudwatch/logGroup:LogGroup"],
    validate(r, ctx) {
        const min = APPROVED.logRetentionDays[stackKind(ctx)];
        const days = r.props.retentionInDays;
        if (!(typeof days === "number" && days >= min)) {
            ctx.reportViolation(`${days === undefined ? "Logs are kept forever" : `Logs are kept ${days} days`}; stack ${ctx.stack} needs a retention of at least ${min} days.`);
        }
    },
});

policy({
    name: "rds-backups-in-prod",
    description: "In prod, RDS instances keep backups for at least 7 days and have deletion protection on.",
    enforcementLevel: "mandatory",
    severity: "high",
    remediationSteps: "Set backupRetentionPeriod and deletionProtection (or use platform.db.Postgres, which does).",
    resourceTypes: ["aws:rds/instance:Instance", "aws:rds/cluster:Cluster"],
    validate(r, ctx) {
        if (ctx.stack !== "prod") {
            return;
        }
        const days = r.props.backupRetentionPeriod;
        const missing = [];
        if (!(typeof days === "number" && days >= APPROVED.rdsBackupDays)) {
            missing.push(`backups kept at least ${APPROVED.rdsBackupDays} days (it has ${days === undefined ? "none set" : days})`);
        }
        if (r.props.deletionProtection !== true) {
            missing.push("deletion protection");
        }
        if (missing.length > 0) {
            const comp = ctx.within(r, "acme:db:Postgres");
            ctx.reportViolation(
                `In prod this database needs ${missing.join(" and ")}; ${comp ? `fix the platform's Postgres component (${r.file})` : "set them for prod, or use platform.db.Postgres, which does"}.`,
            );
        }
    },
});

policy({
    name: "cost-estimate",
    description: "A rough monthly cost per team, from a small price table, stays within the team's budget (stack config teamBudgets).",
    enforcementLevel: "advisory",
    severity: "low",
    remediationSteps: "Downsize the top items for this stack, or raise the team's budget in Pulumi.<stack>.yaml.",
    validate(ctx) {
        const budgets = ctx.config("teamBudgets");
        if (!budgets) {
            return;
        }
        const items = {};
        for (const r of ctx.resources()) {
            let what;
            if (r.type === "acme:db:Postgres") {
                what = POSTGRES_CLASS[r.props.size];
            } else if (r.type === "aws:ec2/instance:Instance") {
                what = r.props.instanceType;
            } else if (r.type === "aws:rds/instance:Instance" && !ctx.within(r, "acme:db:Postgres")) {
                what = r.props.instanceClass;
            } else if (r.type === "aws:ec2/natGateway:NatGateway") {
                what = "natGateway";
            } else if (r.type === "aws:lb/loadBalancer:LoadBalancer") {
                what = "loadBalancer";
            }
            const price = APPROVED.prices[what];
            if (price === undefined) {
                continue;
            }
            const team = [r].concat(ctx.ancestors(r)).map((x) => teamOf(x.file)).find((t) => t) || "unowned";
            (items[team] = items[team] || []).push({ r, what, price });
        }
        for (const team of Object.keys(items).sort()) {
            const total = items[team].reduce((a, x) => a + x.price, 0);
            if (budgets[team] === undefined || total <= budgets[team]) {
                continue;
            }
            const top = items[team].sort((a, b) => b.price - a.price).slice(0, 3).map((x) => `${x.r.name} (${x.what}, ~$${x.price})`);
            ctx.reportViolation(
                `Team ${team} would cost about $${Math.round(total)}/month in ${ctx.stack}, over its $${budgets[team]} budget; the top items are ${top.join(", ")}. Rough list prices.`,
                { file: `Pulumi.${ctx.stack}.yaml` },
            );
        }
    },
});

// ---------------------------------------------------------------------------------------------------------------------
// Network, identity and shared infrastructure
// ---------------------------------------------------------------------------------------------------------------------

policy({
    name: "shared-infra-ownership",
    description: "VPCs, subnets, NAT and internet gateways belong to the network team; KMS keys and DNS zones to the platform team.",
    enforcementLevel: "mandatory",
    severity: "high",
    remediationSteps: "Use the owning team's stack through a stack reference instead of creating your own.",
    resourceTypes: Object.keys(APPROVED.sharedInfra),
    validate(r, ctx) {
        const [owner, instead] = APPROVED.sharedInfra[r.type];
        if (!(r.file || "").startsWith(owner)) {
            ctx.reportViolation(`Only ${owner} creates a ${short(r.type)}; use ${instead}.`);
        }
    },
});

policy({
    name: "public-lb-via-service",
    description: "Internet-facing load balancers are created only through platform.network.Service.",
    enforcementLevel: "mandatory",
    severity: "high",
    remediationSteps: "Use `new platform.network.Service(name, { team, vpcId, port, publicSubnetIds }, { provider })`.",
    resourceTypes: ["aws:lb/loadBalancer:LoadBalancer", "aws:alb/loadBalancer:LoadBalancer"],
    validate(r, ctx) {
        if (r.props.internal !== true && !ctx.within(r, "acme:network:Service")) {
            ctx.reportViolation("Put internet-facing services behind platform.network.Service with public subnets; it adds the security group, target group, logs and TLS defaults.");
        }
    },
});

policy({
    name: "provider-region-allowed",
    description: "Every explicit AWS provider's region is one of the stack's allowed regions (config allowedRegions).",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Use platform.provider(team), which takes the stack's region, or an allowed region.",
    resourceTypes: ["pulumi:providers:aws"],
    validate(r, ctx) {
        const allowed = ctx.config("allowedRegions");
        if (Array.isArray(allowed) && typeof r.props.region === "string" && allowed.indexOf(r.props.region) < 0) {
            ctx.reportViolation(
                `${r.props.region} isn't one of stack ${ctx.stack}'s regions (${allowed.join(", ")}); use the team provider from platform.provider, which takes the stack's region.`,
            );
        }
    },
});

policy({
    name: "no-iam-users",
    description: "No IAM users, access keys or user policies: workloads and CI use roles.",
    enforcementLevel: "mandatory",
    severity: "high",
    remediationSteps: "Use platform.identity.Role (for CI: an OIDC role) instead of an IAM user.",
    resourceTypes: ["aws:iam/user:*", "aws:iam/accessKey:*", "aws:iam/userPolicy:*", "aws:iam/userPolicyAttachment:*", "aws:iam/userLoginProfile:*", "aws:iam/userGroupMembership:*"],
    validate(r, ctx) {
        ctx.reportViolation("IAM users mean long-lived keys; use platform.identity.Role for workloads, and an OIDC role from the platform team for CI.");
    },
});

policy({
    name: "iam-least-privilege",
    description: "IAM policies don't allow `*` actions or resources, and attach only approved AWS managed policies.",
    enforcementLevel: "mandatory",
    severity: "critical",
    remediationSteps: "List the actions and resource ARNs the workload needs; attach only approved managed policies.",
    resourceTypes: ["aws:iam/rolePolicy:*", "aws:iam/policy:*", "aws:iam/userPolicy:*", "aws:iam/groupPolicy:*", "aws:iam/role:Role", "aws:iam/rolePolicyAttachment:*", "aws:iam/policyAttachment:*", "aws:iam/userPolicyAttachment:*", "aws:iam/groupPolicyAttachment:*"],
    validate(r, ctx) {
        const docs = r.type === "aws:iam/role:Role" ? (r.props.inlinePolicies || []).map((p) => p.policy) : [r.props.policy];
        for (const doc of docs) {
            const parsed = ctx.parseJSON(doc);
            const statements = [].concat((parsed && parsed.Statement) || []);
            if (statements.some((s) => s.Effect !== "Deny" && [].concat(s.Action || [], s.Resource || []).indexOf("*") >= 0)) {
                ctx.reportViolation("This policy allows * actions or resources; list the exact actions and the resource ARNs the workload needs.");
            }
        }
        const arn = r.props.policyArn;
        if (typeof arn === "string" && arn.startsWith("arn:aws:iam::aws:policy/") && APPROVED.managedPolicyArns.indexOf(arn) < 0) {
            ctx.reportViolation(
                `The AWS managed policy ${arn.split("/").pop()} isn't approved; attach one of ${APPROVED.managedPolicyArns.map((a) => a.split("/").pop()).join(", ")}, or a policy with the exact actions needed.`,
            );
        }
    },
});

policy({
    name: "role-permission-boundary",
    description: "IAM roles set the company permission boundary; platform.identity.Role does it for you.",
    enforcementLevel: "mandatory",
    severity: "high",
    remediationSteps: "Use platform.identity.Role instead of aws.iam.Role.",
    resourceTypes: ["aws:iam/role:Role"],
    validate(r, ctx) {
        if (!ctx.within(r, "acme:iam:Role") && r.props.permissionsBoundary === undefined) {
            ctx.reportViolation("This role has no permission boundary; use platform.identity.Role, which sets the company boundary.");
        }
    },
});

policy({
    name: "no-hardcoded-arns",
    description: "Resource inputs don't contain literal ARNs (account IDs included); ARNs come from resources, config or lookups.",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Use the resource's `.arn` output, a stack reference, aws.getCallerIdentityOutput, or config.",
    resourceTypes: ["*"],
    validate(r, ctx) {
        if (isProvider(r)) {
            return;
        }
        for (const [path, text] of ctx.strings(r.props)) {
            const m = /arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12})?:?[^\s"']*/.exec(text);
            // AWS managed policies are global names, not resources of ours.
            if (m && !m[0].startsWith("arn:aws:iam::aws:policy/")) {
                ctx.reportViolation(
                    `${path} hardcodes ${m[1] ? `account ${m[1]} in ` : ""}the ARN ${m[0]}; take it from the resource's arn, a stack reference, or aws.getCallerIdentity.`,
                );
                return;
            }
        }
    },
});

policy({
    name: "security-review",
    description: "IAM and network resources declared in app code are flagged for a security review (advisory).",
    enforcementLevel: "advisory",
    severity: "low",
    remediationSteps: "No change needed; a reviewer from security looks at these. Prefer platform components.",
    resourceTypes: ["aws:iam/*", "aws:ec2/securityGroup*", "aws:ec2/vpc*", "aws:ec2/internetGateway*", "aws:ec2/natGateway*", "aws:ec2/networkAcl*", "aws:vpc/securityGroup*", "aws:lb/loadBalancer*", "aws:alb/loadBalancer*"],
    validate(r, ctx) {
        if (!ctx.within(r, "acme:*")) {
            ctx.reportViolation(`This ${short(r.type)} changes identity or network access, so security will review it; platform components don't need this review.`);
        }
    },
});

// ---------------------------------------------------------------------------------------------------------------------
// Definition of done
// ---------------------------------------------------------------------------------------------------------------------

policy({
    name: "service-definition-of-done",
    description: "Every service (platform.network.Service or Lambda function) has an alarm and a log group with retention.",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Add an aws.cloudwatch.MetricAlarm and a LogGroup with retentionInDays that reference the service.",
    resourceTypes: ["acme:network:Service", "aws:lambda/function:Function"],
    validate(r, ctx) {
        if (r.type === "aws:lambda/function:Function" && ctx.within(r, "acme:*")) {
            return;
        }
        const mine = [r].concat(ctx.descendants(r));
        const linked = (x) => mine.indexOf(x) >= 0 || ctx.references(x).some((y) => mine.indexOf(y) >= 0);
        const missing = [];
        if (!ctx.resources("aws:cloudwatch/metricAlarm:MetricAlarm").some(linked)) {
            missing.push("an alarm on it");
        }
        if (!ctx.resources("aws:cloudwatch/logGroup:LogGroup").some((x) => linked(x) && typeof x.props.retentionInDays === "number")) {
            missing.push("a log group with retention");
        }
        if (missing.length > 0) {
            ctx.reportViolation(`This service isn't done: it needs ${missing.join(" and ")}. Every service ships with an alarm and logs that expire.`);
        }
    },
});

policy({
    name: "required-stack-outputs",
    description: "The program exports every stack output listed in the project config requiredOutputs.",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Export the missing outputs from index.ts.",
    validate(ctx) {
        const required = ctx.config("requiredOutputs");
        if (!Array.isArray(required)) {
            return;
        }
        const have = ctx.program.outputs.map((o) => o.name);
        const missing = required.filter((n) => have.indexOf(n) < 0);
        if (missing.length > 0) {
            ctx.reportViolation(`The stack doesn't export ${missing.join(", ")}, which other stacks and tools depend on (requiredOutputs in Pulumi.yaml).`, { file: entryFile(ctx) });
        }
    },
});

// ---------------------------------------------------------------------------------------------------------------------
// Pulumi best practices
// ---------------------------------------------------------------------------------------------------------------------

policy({
    name: "protect-stateful-in-prod",
    description: "In prod, resources that hold data are protected (protect or retainOnDelete).",
    enforcementLevel: "mandatory",
    severity: "high",
    remediationSteps: "Add `protect: pulumi.getStack() === \"prod\"` to the resource options.",
    resourceTypes: ["acme:db:Postgres", "acme:storage:Bucket", "aws:rds/instance:Instance", "aws:rds/cluster:Cluster", "aws:s3/bucket:Bucket", "aws:s3/bucketV2:BucketV2", "aws:dynamodb/table:Table"],
    validate(r, ctx) {
        // A component's children are covered by the component; only confidential platform buckets count.
        if (ctx.stack !== "prod" || ctx.within(r, "acme:*") || (r.type === "acme:storage:Bucket" && r.props.dataClass !== "confidential")) {
            return;
        }
        if (r.options.protect !== true && r.options.retainOnDelete !== true) {
            ctx.reportViolation("This holds data and isn't protected in prod; set protect (or retainOnDelete) in its resource options for prod.");
        }
    },
});

policy({
    name: "secrets-stay-secret",
    description: "Passwords and secret config stay secrets: in resource inputs and in how config is read.",
    enforcementLevel: "mandatory",
    severity: "critical",
    remediationSteps: "Read secret config with `config.requireSecret`/`getSecret`, and pass secrets as Outputs.",
    validate(ctx) {
        const sensitive = ["password", "masterPassword", "secretString", "privateKey", "apiKey", "token"];
        const flagged = [];
        for (const r of ctx.resources()) {
            if (isProvider(r) || ctx.ancestors(r).some((a) => flagged.indexOf(a) >= 0)) {
                continue;
            }
            const f = sensitive.find((k) => typeof r.props[k] === "string" && r.secretInputs.indexOf(k) < 0);
            if (f) {
                flagged.push(r);
                ctx.reportViolation(`${f} is passed as plain text, so it's stored unencrypted in the state; pass a secret, such as one read with config.requireSecret.`, r);
            }
        }
        for (const c of ctx.program.configRead) {
            const declared = ctx.project.config[c.key] || {};
            const set = ctx.project.stackConfig[c.key] || {};
            if ((declared.secret || set.secure) && !c.secret) {
                ctx.reportViolation(`Secret config ${c.key} is read with ${c.method}, which turns it into plain text; use ${c.method.replace(/^(get|require)/, "$1Secret")}.`, c);
            }
        }
    },
});

policy({
    name: "declared-config",
    description: "Every config key the program reads is declared in Pulumi.yaml with a type and description.",
    enforcementLevel: "mandatory",
    severity: "low",
    remediationSteps: "Declare the key under `config:` in Pulumi.yaml.",
    validate(ctx) {
        for (const c of ctx.program.configRead) {
            const d = ctx.project.config[c.key];
            if (c.namespace === ctx.project.name && !(d && d.description)) {
                ctx.reportViolation(`Config ${c.key} is read here but ${d ? "has no description" : "isn't declared"} in Pulumi.yaml; declare it under config with a type and a description.`, c);
            }
        }
    },
});

policy({
    name: "explicit-provider-default-tags",
    description: "AWS resources use the team's explicit provider, which sets default tags (team, env).",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "Pass `{ provider }` from `platform.provider(team)` to every resource.",
    resourceTypes: ["aws:*"],
    validate(r, ctx) {
        if (!r.custom || r.read) {
            return;
        }
        const p = ctx.providerOf(r);
        if (!p) {
            ctx.reportViolation("This uses the default AWS provider, so it gets no default tags and whatever region the environment has; use the team provider from platform.provider.");
            return;
        }
        const tags = (p.props.defaultTags || {}).tags || {};
        const missing = ["team", "env"].filter((t) => !tags[t]);
        if (missing.length > 0) {
            ctx.reportViolation(`Provider ${p.name} sets no default ${missing.join(" or ")} tag; use the team provider from platform.provider instead of a hand-made one.`);
        }
    },
});

policy({
    name: "no-ignore-changes-wildcard",
    description: "Resources don't ignore all changes (`ignoreChanges: [\"*\"]`).",
    enforcementLevel: "mandatory",
    severity: "medium",
    remediationSteps: "List the specific properties another system manages, or remove ignoreChanges.",
    resourceTypes: ["*"],
    validate(r, ctx) {
        if ((r.options.ignoreChanges || []).indexOf("*") >= 0) {
            ctx.reportViolation("ignoreChanges on everything hides all drift and all future changes; list only the properties something else manages, or remove it.");
        }
    },
});

policy({
    name: "dependency-hygiene",
    description: "package.json pins versions (no latest or *), with supported Pulumi SDK majors.",
    enforcementLevel: "advisory",
    severity: "low",
    remediationSteps: "Pin a version range in package.json and commit the lockfile.",
    validate(ctx) {
        const pj = ctx.program.packageJson;
        const minMajor = { "@pulumi/pulumi": 3, "@pulumi/aws": 7 };
        const deps = Object.assign({}, pj.devDependencies, pj.dependencies);
        for (const name of Object.keys(deps).sort()) {
            const range = String(deps[name]);
            const major = /(\d+)/.exec(range);
            if (ctx.program.localPackages[name]) {
                continue;
            } else if (/^(latest|\*|x|)$/.test(range.trim()) || /^(git|https?):|^github:/.test(range)) {
                ctx.reportViolation(`${name} is "${range}"; pin the version range you tested, so scans, previews and deployments run the same code.`, { file: "package.json" });
            } else if (minMajor[name] && major && parseInt(major[1], 10) < minMajor[name]) {
                ctx.reportViolation(`${name} ${range} is too old; major ${minMajor[name]} or later is required.`, { file: "package.json" });
            }
        }
    },
});

globalThis.__pulumiPolicyPack = {
    abiVersion: 1,
    name: "acme-guardrails",
    version: "0.1.0",
    description: "Acme guardrails: golden-path components, conventions and Pulumi best practices.",
    policies: policyList,
};
// For tools (agent-rules.js): the policies as written, and the approved choices.
globalThis.__acmeGuardrails = { policies: authored, approved: APPROVED };
