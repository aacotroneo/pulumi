import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

/**
 * @deprecated Since @acme/platform 2.0. Use the components in `@acme/platform`.
 */
export class Queue extends pulumi.ComponentResource {
    public readonly url: pulumi.Output<string>;

    constructor(name: string, args: { team: string }, opts?: pulumi.ComponentResourceOptions) {
        super("acme:legacy:Queue", name, args, opts);
        const q = new aws.sqs.Queue(name, { tags: { team: args.team } }, { parent: this });
        this.url = q.url;
        this.registerOutputs({ url: this.url });
    }
}
