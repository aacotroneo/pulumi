import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as platform from "@acme/platform";

const team = "search";
const config = new pulumi.Config();
const isProd = pulumi.getStack() === "prod";
const provider = platform.provider(team);
const network = new pulumi.StackReference(`acme/network/${pulumi.getStack()}`);
const vpcId = network.requireOutput("vpcId");

export const index = new platform.storage.Bucket("search-index", { team, dataClass: "internal" }, { provider });

export const db = new platform.db.Postgres(
    "search-db",
    { team, size: isProd ? "medium" : "small", password: config.requireSecret("searchDbPassword") },
    { provider, protect: isProd },
);

const api = new platform.network.Service("search-api", { team, vpcId, port: 8080 }, { provider });
api.allowFrom("search-api-from-office", "10.20.0.0/16");
new aws.cloudwatch.MetricAlarm("search-api-5xx", { comparisonOperator: "GreaterThanThreshold", evaluationPeriods: 1, metricName: "HTTPCode_Target_5XX_Count", namespace: "AWS/ApplicationELB", period: 300, statistic: "Sum", threshold: 10, dimensions: { TargetGroup: api.targetGroupArnSuffix } }, { provider });

const deadLetters = new aws.sqs.Queue("search-dead-letters", {}, { provider });
export const reindex = new aws.sqs.Queue(
    "search-reindex",
    { redrivePolicy: pulumi.jsonStringify({ deadLetterTargetArn: deadLetters.arn, maxReceiveCount: 5 }) },
    { provider },
);
