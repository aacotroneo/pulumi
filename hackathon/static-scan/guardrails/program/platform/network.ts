import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface ServiceArgs {
    team: string;
    vpcId: pulumi.Input<string>;
    port: number;
    /** Put the service behind an internet-facing load balancer in these public subnets. */
    publicSubnetIds?: pulumi.Input<pulumi.Input<string>[]>;
}

/**
 * An HTTP service's network: a security group that admits only the private network, a target group, a log group
 * (14 days in dev, 90 in prod) and, with `publicSubnetIds`, an internet-facing load balancer.
 * To let more traffic in, call `allowFrom`; don't add rules to `securityGroup` from outside.
 * Add an alarm on `targetGroupArnSuffix` (the definition of done for a service).
 */
export class Service extends pulumi.ComponentResource {
    public readonly securityGroup: aws.ec2.SecurityGroup;
    public readonly targetGroupArnSuffix: pulumi.Output<string>;
    public readonly url: pulumi.Output<string> | undefined;
    private readonly port: number;

    constructor(name: string, args: ServiceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("acme:network:Service", name, args, opts);
        this.port = args.port;
        this.securityGroup = new aws.ec2.SecurityGroup(
            `${name}-sg`,
            {
                vpcId: args.vpcId,
                description: `${name}: internal traffic only`,
                ingress: [{ protocol: "tcp", fromPort: args.port, toPort: args.port, cidrBlocks: ["10.0.0.0/8"] }],
                tags: { team: args.team },
            },
            { parent: this },
        );
        const tg = new aws.lb.TargetGroup(
            `${name}-tg`,
            { port: args.port, protocol: "HTTP", targetType: "ip", vpcId: args.vpcId, tags: { team: args.team } },
            { parent: this },
        );
        this.targetGroupArnSuffix = tg.arnSuffix;
        new aws.cloudwatch.LogGroup(
            `${name}-logs`,
            { retentionInDays: pulumi.getStack() === "prod" ? 90 : 14, tags: { team: args.team } },
            { parent: this },
        );
        if (args.publicSubnetIds) {
            const lb = new aws.lb.LoadBalancer(
                `${name}-lb`,
                { internal: false, loadBalancerType: "application", subnets: args.publicSubnetIds, tags: { team: args.team } },
                { parent: this },
            );
            this.url = pulumi.interpolate`https://${lb.dnsName}`;
        }
        this.registerOutputs({ securityGroupId: this.securityGroup.id });
    }

    /** Admits a private CIDR to the service port; the platform reviews these rules. */
    public allowFrom(name: string, cidr: string): aws.ec2.SecurityGroupRule {
        return new aws.ec2.SecurityGroupRule(
            name,
            {
                type: "ingress",
                securityGroupId: this.securityGroup.id,
                protocol: "tcp",
                fromPort: this.port,
                toPort: this.port,
                cidrBlocks: [cidr],
            },
            { parent: this },
        );
    }
}
