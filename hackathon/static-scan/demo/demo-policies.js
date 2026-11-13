// Demo policies for `pulumi policy lint` (purejs ABI v2), appended to an existing pack bundle by make-demo-pack.sh.
//
// database-not-reachable-from-internet joins resources through outputs only: an RDS instance names its security
// groups by id (`vpcSecurityGroupIds: [sg.id]`), and standalone rules name their group the same way
// (`securityGroupId: sg.id`). Before anything is deployed those ids are identifiable unknowns, the same opaque value
// on both sides, so `===` links them.
(() => {
    const pack = globalThis.__pulumiPolicyPack;
    const OPEN = ["0.0.0.0/0", "::/0"];
    const DB_TYPES = ["aws:rds/instance:Instance", "aws:rds/cluster:Cluster"];
    const SG = "aws:ec2/securityGroup:SecurityGroup";

    const list = (v) => (Array.isArray(v) ? v : []);
    const isOpen = (v) => OPEN.indexOf(v) >= 0;
    const ports = (from, to) => (from === to ? `port ${from}` : `ports ${from}-${to}`);

    // Every rule that lets the internet into `sg`, wherever the program declared it.
    function openIngress(sg, resources) {
        const found = [];
        for (const rule of list(sg.inputs.ingress)) {
            const cidr = list(rule.cidrBlocks).find(isOpen) || list(rule.ipv6CidrBlocks).find(isOpen);
            if (cidr) {
                found.push({ urn: sg.urn, what: `an inline ingress rule on ${ports(rule.fromPort, rule.toPort)} from ${cidr}` });
            }
        }
        for (const r of resources) {
            const i = r.inputs;
            if (r.type === "aws:vpc/securityGroupIngressRule:SecurityGroupIngressRule" && i.securityGroupId === sg.outputs.id) {
                const cidr = isOpen(i.cidrIpv4) ? i.cidrIpv4 : isOpen(i.cidrIpv6) ? i.cidrIpv6 : undefined;
                if (cidr) {
                    found.push({ urn: r.urn, what: `ingress rule '${r.name}' on ${ports(i.fromPort, i.toPort)} from ${cidr}` });
                }
            }
            if (r.type === "aws:ec2/securityGroupRule:SecurityGroupRule" && i.type === "ingress" && i.securityGroupId === sg.outputs.id) {
                const cidr = list(i.cidrBlocks).find(isOpen) || list(i.ipv6CidrBlocks).find(isOpen);
                if (cidr) {
                    found.push({ urn: r.urn, what: `rule '${r.name}' on ${ports(i.fromPort, i.toPort)} from ${cidr}` });
                }
            }
        }
        return found;
    }

    pack.policies.push({
        name: "database-not-reachable-from-internet",
        description: "Databases must not be reachable from the internet through their security groups.",
        enforcementLevel: "mandatory",
        severity: "critical",
        resourceTypes: DB_TYPES,
        validate({ resource, resources }, { reportViolation, reportPass }) {
            const ids = list(resource.inputs.vpcSecurityGroupIds);
            if (ids.length === 0) {
                return; // Not applicable: no security groups named.
            }
            const groups = resources.filter((r) => r.type === SG && ids.some((id) => id === r.outputs.id));
            let violations = 0;
            for (const sg of groups) {
                for (const open of openIngress(sg, resources)) {
                    violations++;
                    reportViolation(
                        `Database '${resource.name}' is reachable from the internet: its security group '${sg.name}' ` +
                            `has ${open.what}. Allow only the application's security group or private CIDRs.`,
                    );
                    reportViolation(
                        `This rule exposes database '${resource.name}' to the internet (security group '${sg.name}').`,
                        open.urn,
                    );
                }
            }
            if (violations === 0) {
                reportPass();
            }
        },
    });
})();
