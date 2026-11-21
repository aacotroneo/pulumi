import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as platform from "@acme/platform";
import { Queue } from "@acme/platform/legacy"; // violates: approved-platform-modules
import { execSync } from "child_process";
import { api } from "./network";
export * from "./identity";

const team = "search";
const config = new pulumi.Config();
const provider = platform.provider(team);

const release = execSync("git rev-parse --short HEAD").toString().trim(); // violates: hermetic-program
const replicas = config.getNumber("indexReplicas") ?? 1; // violates: declared-config

// Copied from payments: the owning team was never changed.
export const index = new platform.storage.Bucket("search-index", { team: "payments", dataClass: "internal" }, { provider }); // violates: team-ownership
export const assets = new platform.storage.Bucket("search-assets", { team, dataClass: "public" }, { provider }); // violates: bucket-component-invariants

export const db = new platform.db.Postgres( // violates: protect-stateful-in-prod(prod), secrets-stay-secret
    "search-db",
    { team, size: pulumi.getStack() === "prod" ? "medium" : "small", password: config.require("searchDbPassword") }, // violates: secrets-stay-secret
    { provider },
);

api.allowFrom("search-api-from-office", "10.20.0.0/16");
new aws.ec2.SecurityGroupRule("search-api-ssh", { type: "ingress", securityGroupId: api.securityGroup.id, protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] }, { provider }); // violates: component-encapsulation, security-review

new aws.sqs.Queue("searchEvents", { name: "search-events", tags: { release, replicas: String(replicas) } }, { provider }); // violates: kebab-case-names, physical-name-prefix
const deadLetters = new aws.sqs.Queue("search-dead-letters", { name: `${pulumi.getProject()}-${pulumi.getStack()}-search-dead-letters` }, { provider });
const reindex = new aws.sqs.Queue("search-reindex", { redrivePolicy: deadLetters.arn.apply((arn) => JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 })) }); // violates: explicit-provider-default-tags, team-ownership

new aws.sqs.QueuePolicy("search-reindex-policy", { // violates: no-hardcoded-arns
    queueUrl: reindex.url,
    policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::123456789012:role/search-indexer" }, Action: "sqs:SendMessage", Resource: "*" }] }),
}, { provider });

const indexer = aws.getCallerIdentityOutput({}, { provider });
new aws.sqs.QueuePolicy("search-dead-letters-policy", {
    queueUrl: deadLetters.url,
    policy: pulumi.jsonStringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: pulumi.interpolate`arn:aws:iam::${indexer.accountId}:role/search-indexer` }, Action: "sqs:SendMessage", Resource: "*" }] }),
}, { provider });

new Queue("search-legacy-jobs", { team }, { provider }); // violates: approved-platform-modules
