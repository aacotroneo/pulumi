import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as platform from "@acme/platform";

const team = "payments";
const isProd = pulumi.getStack() === "prod";
const provider = platform.provider(team);

export const receipts = new platform.storage.Bucket("payments-receipts", { team, dataClass: "confidential" }, { provider, protect: isProd });

new aws.cloudwatch.LogGroup("payments-api-logs", { retentionInDays: isProd ? 90 : 14 }, { provider });
