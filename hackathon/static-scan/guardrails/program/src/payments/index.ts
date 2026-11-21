import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as platform from "@acme/platform";

const team = "payments";
const config = new pulumi.Config();
const isProd = pulumi.getStack() === "prod";
const provider = platform.provider(team);

// The golden path: a platform bucket, protected in prod because it holds confidential data.
export const receipts = new platform.storage.Bucket("payments-receipts", { team, dataClass: "confidential" }, { provider, protect: isProd });

// A raw bucket: no encryption, versioning or public access block unless someone remembers.
const exportsBucket = new aws.s3.Bucket("payments-exports", { tags: { team } }, { provider }); // violates: use-platform-bucket, protect-stateful-in-prod(prod)

export const db = new platform.db.Postgres( // violates: postgres-size-by-stack(dev)
    "payments-db",
    { team, size: config.get<platform.db.Size>("dbSize") ?? "small", password: config.requireSecret("paymentsDbPassword") },
    { provider, protect: isProd },
);

// A raw RDS read replica next to the platform database.
const ledgerReplica = new aws.rds.Instance("payments-ledger-replica", { instanceClass: "db.t4g.small", replicateSourceDb: "payments-db" }, { provider }); // violates: use-platform-database, protect-stateful-in-prod(prod), rds-backups-in-prod(prod)

// Compliant: a resource that depends on an output takes the output as an input.
new aws.ssm.Parameter("payments-db-host", { type: "String", value: db.endpoint }, { provider });

db.endpoint.apply((endpoint) => {
    new aws.ssm.Parameter("payments-db-url", { type: "String", value: `postgres://${endpoint}/payments` }, { provider }); // violates: no-resources-in-apply
});

new aws.cloudwatch.LogGroup("payments-api-logs", { retentionInDays: 30 }, { provider, ignoreChanges: ["*"] }); // violates: no-ignore-changes-wildcard, log-retention-by-stack(prod)
new aws.cloudwatch.LogGroup("payments-worker-logs", { retentionInDays: 90 }, { provider, ignoreChanges: ["retentionInDays"] });

export const exportsBucketName = exportsBucket.bucket;
export const ledgerReplicaEndpoint = ledgerReplica.endpoint;
export * from "./webhook";
