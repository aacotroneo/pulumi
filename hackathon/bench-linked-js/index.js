// The linked bench (../bench-linked/Pulumi.yaml), resource for resource, plus a last section of links that only output
// sources can resolve (lists holding outputs of several new resources, and documents derived from outputs).
"use strict";
const aws = require("@pulumi/aws");
const pulumi = require("@pulumi/pulumi");

// --- S3: a compliant bucket (companions reference good.id) and a bare one ---
const good = new aws.s3.Bucket("good");
const logs = new aws.s3.Bucket("logs");
const bare = new aws.s3.Bucket("bare");
const key = new aws.kms.Key("key", { enableKeyRotation: true });
new aws.s3.BucketPublicAccessBlock("goodPab", {
    bucket: good.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
});
new aws.s3.BucketVersioning("goodVersioning", { bucket: good.id, versioningConfiguration: { status: "Enabled" } });
new aws.s3.BucketServerSideEncryptionConfiguration("goodSse", {
    bucket: good.id,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "aws:kms", kmsMasterKeyId: key.arn }, bucketKeyEnabled: true }],
});
new aws.s3.BucketLogging("goodLogging", { bucket: good.id, targetBucket: logs.id, targetPrefix: "good/" });
new aws.s3.BucketLifecycleConfiguration("goodLifecycle", {
    bucket: good.id,
    rules: [{ id: "expire", status: "Enabled", filter: {}, expiration: { days: 90 } }],
});
// A PAB that is linked but misconfigured: should be a real violation in preview.
new aws.s3.BucketPublicAccessBlock("barePab", {
    bucket: bare.id,
    blockPublicAcls: false,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
});

// --- KMS + EFS ---
new aws.efs.FileSystem("efs", { encrypted: true, kmsKeyId: key.arn });

// --- VPC with a flow log, and one without ---
const vpc = new aws.ec2.Vpc("vpc", { cidrBlock: "10.0.0.0/16" });
const subnetA = new aws.ec2.Subnet("subnetA", { vpcId: vpc.id, cidrBlock: "10.0.1.0/24", availabilityZone: "us-west-2a" });
const subnetB = new aws.ec2.Subnet("subnetB", { vpcId: vpc.id, cidrBlock: "10.0.2.0/24", availabilityZone: "us-west-2b" });
const flowLogGroup = new aws.cloudwatch.LogGroup("flowLogGroup", { retentionInDays: 365 });
const flowLogRole = new aws.iam.Role("flowLogRole", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "vpc-flow-logs.amazonaws.com" }, Action: "sts:AssumeRole" }],
    }),
});
new aws.ec2.FlowLog("flowLog", {
    vpcId: vpc.id,
    trafficType: "ALL",
    logDestination: flowLogGroup.arn,
    iamRoleArn: flowLogRole.arn,
});
const vpcNoLogs = new aws.ec2.Vpc("vpcNoLogs", { cidrBlock: "10.1.0.0/16" });
new aws.ec2.Subnet("subnetNoLogs", { vpcId: vpcNoLogs.id, cidrBlock: "10.1.1.0/24" });

// --- Security groups: one attached to an ENI, one orphaned ---
const appSg = new aws.ec2.SecurityGroup("appSg", { vpcId: vpc.id, description: "attached" });
new aws.ec2.NetworkInterface("eni", { subnetId: subnetA.id, securityGroups: [appSg.id] });
new aws.ec2.SecurityGroup("orphanSg", { vpcId: vpc.id, description: "orphan" });

// --- EBS: one attached volume, one unused ---
const instance = new aws.ec2.Instance("instance", {
    ami: "ami-0123456789abcdef0",
    instanceType: "t3.micro",
    subnetId: subnetA.id,
    vpcSecurityGroupIds: [appSg.id],
    metadataOptions: { httpTokens: "required" },
});
const volume = new aws.ebs.Volume("volume", { availabilityZone: "us-west-2a", size: 10, encrypted: true, kmsKeyId: key.arn });
new aws.ec2.VolumeAttachment("attachment", { deviceName: "/dev/sdh", volumeId: volume.id, instanceId: instance.id });
new aws.ebs.Volume("unusedVolume", { availabilityZone: "us-west-2a", size: 10, encrypted: true });

// --- ALB protected by a WAFv2 web ACL ---
const alb = new aws.lb.LoadBalancer("alb", {
    loadBalancerType: "application",
    subnets: [subnetA.id, subnetB.id],
    securityGroups: [appSg.id],
    dropInvalidHeaderFields: true,
});
const acl = new aws.wafv2.WebAcl("acl", {
    scope: "REGIONAL",
    defaultAction: { allow: {} },
    visibilityConfig: { cloudwatchMetricsEnabled: true, metricName: "acl", sampledRequestsEnabled: true },
});
new aws.wafv2.WebAclAssociation("aclAssociation", { resourceArn: alb.arn, webAclArn: acl.arn });

// --- IAM user in a group ---
const user = new aws.iam.User("user");
const group = new aws.iam.Group("group");
new aws.iam.UserGroupMembership("membership", { user: user.name, groups: [group.name] });

// --- Secret with rotation ---
const secret = new aws.secretsmanager.Secret("secret", { kmsKeyId: key.arn });
new aws.secretsmanager.SecretRotation("rotation", {
    secretId: secret.id,
    rotationLambdaArn: "arn:aws:lambda:us-west-2:123456789012:function:rotate",
    rotationRules: { automaticallyAfterDays: 30 },
});

// --- Only in this copy: lists of outputs of several new resources, and a document derived from outputs ---
const dbSg = new aws.ec2.SecurityGroup("dbSg", { vpcId: vpc.id, description: "db" });
new aws.ec2.NetworkInterface("eniMulti", { subnetId: subnetB.id, securityGroups: [appSg.id, dbSg.id] });
const dbSubnets = new aws.rds.SubnetGroup("db-subnets", { subnetIds: [subnetA.id, subnetB.id] });
new aws.rds.Instance("db", {
    engine: "postgres",
    instanceClass: "db.t3.micro",
    allocatedStorage: 20,
    username: "app",
    manageMasterUserPassword: true,
    dbSubnetGroupName: dbSubnets.name,
    vpcSecurityGroupIds: [dbSg.id],
    storageEncrypted: true,
    kmsKeyId: key.arn,
});
new aws.s3.BucketPolicy("goodPolicy", {
    bucket: good.id,
    policy: pulumi.jsonStringify({
        Version: "2012-10-17",
        // BENCH_BAD_POLICY=1 swaps in a public grant, to check that policies at preview catch it.
        Statement: process.env.BENCH_BAD_POLICY ? [{
            Sid: "PublicEverything",
            Effect: "Allow",
            Principal: "*",
            Action: "s3:*",
            Resource: [good.arn, pulumi.interpolate`${good.arn}/*`],
        }] : [{
            Sid: "DenyInsecureTransport",
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: [good.arn, pulumi.interpolate`${good.arn}/*`],
            Condition: { Bool: { "aws:SecureTransport": "false" } },
        }],
    }),
});
