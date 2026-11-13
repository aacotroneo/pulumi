import * as aws from "@pulumi/aws";

const vpc = new aws.ec2.Vpc("app", { cidrBlock: "10.0.0.0/16" });
const subnetA = new aws.ec2.Subnet("app-a", {
  vpcId: vpc.id,
  cidrBlock: "10.0.1.0/24",
  availabilityZone: "us-west-2a",
});
const subnetB = new aws.ec2.Subnet("app-b", {
  vpcId: vpc.id,
  cidrBlock: "10.0.2.0/24",
  availabilityZone: "us-west-2b",
});

// The application tier.
const appSg = new aws.ec2.SecurityGroup("app", {
  vpcId: vpc.id,
  description: "application servers",
});

// The database tier: only the application may connect.
const dbSg = new aws.ec2.SecurityGroup("db", {
  vpcId: vpc.id,
  description: "postgres",
});

new aws.vpc.SecurityGroupIngressRule("db-from-app", {
  securityGroupId: dbSg.id,
  referencedSecurityGroupId: appSg.id,
  ipProtocol: "tcp",
  fromPort: 5432,
  toPort: 5432,
});

// Debugging access someone added "temporarily".
new aws.vpc.SecurityGroupIngressRule("db-debug", {
  securityGroupId: dbSg.id,
  cidrIpv4: "0.0.0.0/16",
  ipProtocol: "tcp",
  fromPort: 5432,
  toPort: 5432,
});

const subnets = new aws.rds.SubnetGroup("db", {
  subnetIds: [subnetA.id, subnetB.id],
});

export const db = new aws.rds.Instance("orders", {
  engine: "postgres",
  instanceClass: "db.t4g.micro",
  allocatedStorage: 20,
  username: "orders",
  manageMasterUserPassword: true,
  storageEncrypted: true,
  dbSubnetGroupName: subnets.name,
  vpcSecurityGroupIds: [dbSg.id],
  skipFinalSnapshot: true,
}).endpoint;
