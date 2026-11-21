import * as aws from "@pulumi/aws";
import * as platform from "@acme/platform";

const team = "search";
const provider = platform.provider(team);
const lambdaTrust = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

// A CI user with long-lived keys, and a hand-made role with admin rights.
new aws.iam.User("search-ci", {}, { provider }); // violates: no-iam-users, security-review
const indexer = new aws.iam.Role("search-indexer", { assumeRolePolicy: lambdaTrust }, { provider }); // violates: role-permission-boundary, security-review
new aws.iam.RolePolicy("search-indexer-all", { role: indexer.id, policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] }) }, { provider }); // violates: iam-least-privilege, security-review
new aws.iam.RolePolicyAttachment("search-indexer-admin", { role: indexer.name, policyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }, { provider }); // violates: iam-least-privilege, security-review

// Compliant: the platform role sets the permission boundary; only approved managed policies.
export const worker = new platform.identity.Role("search-worker", { team, service: "lambda.amazonaws.com", managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"] }, { provider });
