import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as platform from "@acme/platform";

const team = "payments";
const provider = platform.provider(team);

const role = new platform.identity.Role("payments-webhook", { team, service: "lambda.amazonaws.com", managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"] }, { provider });

// A function with no alarm and no log group with retention.
export const webhook = new aws.lambda.Function("payments-webhook", { // violates: service-definition-of-done
    runtime: "nodejs20.x",
    handler: "index.handler",
    role: role.arn,
    code: new pulumi.asset.AssetArchive({ "index.js": new pulumi.asset.StringAsset("exports.handler = async () => ({ statusCode: 200 });") }),
}, { provider });

// A key of its own, and an account-level setting: both belong to the platform team.
new aws.kms.Key("payments-key", { description: "payments data" }, { provider }); // violates: shared-infra-ownership
new aws.iam.AccountAlias("payments-alias", { accountAlias: "acme-payments" }, { provider }); // violates: forbidden-resource-types, security-review
