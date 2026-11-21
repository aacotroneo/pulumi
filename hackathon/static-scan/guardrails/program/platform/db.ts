import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export type Size = "small" | "medium" | "large";

const instanceClasses: Record<Size, string> = {
    small: "db.t4g.small",
    medium: "db.r6g.large",
    large: "db.r6g.2xlarge",
};

export interface PostgresArgs {
    /** The owning team; it must match the `src/<team>/` directory the database is declared in. */
    team: string;
    /** small (dev), medium or large (prod). */
    size: Size;
    /** The master password. Pass a secret: `config.requireSecret(...)`. */
    password: pulumi.Input<string>;
}

/**
 * A private, encrypted Postgres 16 instance with backups. Protect it in prod with `{ protect: true }`.
 */
export class Postgres extends pulumi.ComponentResource {
    public readonly endpoint: pulumi.Output<string>;

    constructor(name: string, args: PostgresArgs, opts?: pulumi.ComponentResourceOptions) {
        super("acme:db:Postgres", name, args, opts);
        const instance = new aws.rds.Instance(
            name,
            {
                engine: "postgres",
                engineVersion: "16.4",
                instanceClass: instanceClasses[args.size],
                allocatedStorage: 50,
                storageEncrypted: true,
                publiclyAccessible: false,
                username: "app",
                password: args.password,
                backupRetentionPeriod: 7,
                deletionProtection: pulumi.getStack() === "prod",
                skipFinalSnapshot: false,
                finalSnapshotIdentifier: `${name}-final`,
                tags: { team: args.team },
            },
            { parent: this },
        );
        this.endpoint = instance.endpoint;
        this.registerOutputs({ endpoint: this.endpoint });
    }
}
