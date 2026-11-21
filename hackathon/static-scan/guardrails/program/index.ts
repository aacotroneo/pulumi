// The entry point only wires the teams' modules together and exports their outputs.
import * as aws from "@pulumi/aws";
import * as platform from "@acme/platform";
import * as payments from "./src/payments";
import * as search from "./src/search";
import * as ops from "./lib/ops";

const alerts = new aws.sns.Topic("ops-alerts", {}, { provider: platform.provider("platform") }); // violates: no-resources-in-entrypoint

export const receiptsBucket = payments.receipts.bucketName;
export const paymentsDbEndpoint = payments.db.endpoint;
export const searchDbEndpoint = search.db.endpoint;
export const alertsTopic = alerts.arn;
export const pagerTopic = ops.pager.arn;
