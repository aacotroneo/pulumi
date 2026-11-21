// Golden-path inventory: one advisory stack policy that always reports, as a JSON message, the share of cloud
// resources created through platform components, the components in use (with the platform package's version) and
// the provider packages and versions. Run with inventory.sh; it reads the scan context on the Stack resource.
globalThis.__pulumiPolicyPack = {
    abiVersion: 1,
    name: "acme-inventory",
    version: "0.1.0",
    policies: [
        {
            name: "golden-path-inventory",
            description: "Inventory of golden-path adoption (always reported; advisory).",
            enforcementLevel: "advisory",
            kind: "stack",
            validate(input, ctx) {
                const stack = input.resources.find((r) => r.type === "pulumi:pulumi:Stack");
                let scan;
                try {
                    scan = stack && stack.props.scan;
                } catch (e) {
                    scan = undefined;
                }
                if (!scan) {
                    return;
                }
                const byUrn = {};
                input.resources.forEach((r) => (byUrn[r.urn] = r));
                const supported = ["acme:storage:Bucket", "acme:db:Postgres", "acme:network:Service", "acme:iam:Role"];
                const platformAncestor = (r) => {
                    for (let p = byUrn[r.parent]; p; p = byUrn[p.parent]) {
                        if (supported.indexOf(p.type) >= 0) {
                            return p;
                        }
                    }
                    return undefined;
                };
                let cloud = 0;
                let golden = 0;
                const raw = {};
                const components = {};
                const providers = {};
                for (const r of input.resources) {
                    const info = scan.resources[r.urn] || {};
                    if (r.type.startsWith("acme:")) {
                        components[r.type] = (components[r.type] || 0) + 1;
                    }
                    if (!info.custom || info.read || r.type.startsWith("pulumi:")) {
                        continue;
                    }
                    const pkg = r.type.split(":")[0];
                    providers[`${pkg}@${info.version || "?"}`] = true;
                    cloud++;
                    if (platformAncestor(r)) {
                        golden++;
                    } else {
                        raw[r.type] = (raw[r.type] || 0) + 1;
                    }
                }
                const platform = scan.program.localPackages["@acme/platform"] || {};
                ctx.reportViolation(
                    JSON.stringify({
                        stack: scan.stack,
                        cloudResources: cloud,
                        throughPlatformComponents: golden,
                        goldenPathShare: cloud ? Math.round((100 * golden) / cloud) / 100 : 0,
                        platformVersion: platform.version || null,
                        components,
                        rawByType: raw,
                        providers: Object.keys(providers).sort(),
                    }),
                );
            },
        },
    ],
};
