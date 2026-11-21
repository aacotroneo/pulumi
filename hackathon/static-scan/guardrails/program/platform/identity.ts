import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

let platformStack: pulumi.StackReference | undefined;
function platformOutputs(): pulumi.StackReference {
    platformStack = platformStack ?? new pulumi.StackReference(`acme/platform/${pulumi.getStack()}`);
    return platformStack;
}

export interface RoleArgs {
    team: string;
    /** The AWS service that assumes the role, e.g. "lambda.amazonaws.com". */
    service: string;
    /** AWS managed policies to attach; only the approved ones (see the guardrails' `iam-least-privilege`). */
    managedPolicyArns?: string[];
}

/**
 * An IAM role for a workload, with the company's permission boundary (from the platform stack) always set.
 */
export class Role extends pulumi.ComponentResource {
    public readonly arn: pulumi.Output<string>;
    public readonly name: pulumi.Output<string>;

    constructor(name: string, args: RoleArgs, opts?: pulumi.ComponentResourceOptions) {
        super("acme:iam:Role", name, args, opts);
        const role = new aws.iam.Role(
            name,
            {
                assumeRolePolicy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [{ Effect: "Allow", Principal: { Service: args.service }, Action: "sts:AssumeRole" }],
                }),
                permissionsBoundary: platformOutputs().requireOutput("permissionsBoundaryArn"),
                tags: { team: args.team },
            },
            { parent: this },
        );
        (args.managedPolicyArns ?? []).forEach((policyArn, i) => {
            new aws.iam.RolePolicyAttachment(`${name}-managed-${i}`, { role: role.name, policyArn }, { parent: this });
        });
        this.arn = role.arn;
        this.name = role.name;
        this.registerOutputs({ arn: this.arn });
    }
}
