import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as platform from "@acme/platform";

const team = "search";
const provider = platform.provider(team);
const network = new pulumi.StackReference(`acme/network/${pulumi.getStack()}`);

// Compliant: the service component puts the API behind its own public load balancer, with a log group; the team
// adds the alarm.
export const api = new platform.network.Service("search-api", { team, vpcId: network.requireOutput("vpcId"), port: 8080, publicSubnetIds: network.requireOutput("publicSubnetIds") as pulumi.Output<string[]> }, { provider });
new aws.cloudwatch.MetricAlarm("search-api-5xx", { comparisonOperator: "GreaterThanThreshold", evaluationPeriods: 1, metricName: "HTTPCode_Target_5XX_Count", namespace: "AWS/ApplicationELB", period: 300, statistic: "Sum", threshold: 10, dimensions: { TargetGroup: api.targetGroupArnSuffix } }, { provider });

// A VPC of its own and a hand-made public load balancer, instead of the network stack and the service component.
const vpc = new aws.ec2.Vpc("search-vpc", { cidrBlock: "10.42.0.0/16" }, { provider }); // violates: shared-infra-ownership, security-review
new aws.lb.LoadBalancer("search-public", { internal: false, loadBalancerType: "application", subnets: network.requireOutput("publicSubnetIds") as pulumi.Output<string[]> }, { provider }); // violates: public-lb-via-service, security-review

// A provider pinned to a region the stack doesn't allow.
const eu = new aws.Provider("search-eu", { region: "eu-west-1", defaultTags: { tags: { team, env: pulumi.getStack(), "managed-by": "pulumi" } } }); // violates: provider-region-allowed

// A bastion host: general-purpose instances are for prod only.
new aws.ec2.Instance("search-bastion", { instanceType: "m6i.large", ami: "ami-0123456789abcdef0", subnetId: vpc.id }, { provider }); // violates: instance-types-by-stack(dev)
new aws.ec2.Instance("search-runner", { instanceType: "t4g.small", ami: "ami-0123456789abcdef0", subnetId: vpc.id }, { provider });

// A name that changes on every run.
new aws.sqs.Queue(`search-scratch-${Date.now()}`, {}, { provider }); // violates: deterministic-names

export const euProvider = eu;
