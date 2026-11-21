import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const providers = new Map<string, aws.Provider>();

/**
 * The AWS provider a team deploys with: the stack's region, and default tags (team, env) on every resource.
 * Pass it as `{ provider }` to every resource and component.
 */
export function provider(team: string): aws.Provider {
    let p = providers.get(team);
    if (!p) {
        p = new aws.Provider(`${team}-aws`, {
            region: new pulumi.Config("aws").require("region") as aws.Region,
            defaultTags: { tags: { team, env: pulumi.getStack(), "managed-by": "pulumi" } },
        });
        providers.set(team, p);
    }
    return p;
}
