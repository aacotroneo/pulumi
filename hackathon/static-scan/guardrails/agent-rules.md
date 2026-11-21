## Infrastructure guardrails (acme-guardrails 0.1.0)

This program is checked by a policy pack. Write code that passes it the first time; then check with
`pulumi policy scan . --policy-pack <pack> --stack dev` (and `--stack prod`). Mandatory findings must be fixed.

### Approved choices

- Every resource and component gets the team provider: `const provider = platform.provider("<team>")`, with `import * as platform from "@acme/platform"`.
- `acme:storage:Bucket`: `new platform.storage.Bucket(name, { team, dataClass: "public" | "internal" | "confidential" }, { provider })`
- `acme:db:Postgres`: `new platform.db.Postgres(name, { team, size, password: config.requireSecret(key) }, { provider, protect: isProd })`
- `acme:network:Service`: `new platform.network.Service(name, { team, vpcId, port, publicSubnetIds? }, { provider })`
- `acme:iam:Role`: `new platform.identity.Role(name, { team, service: "lambda.amazonaws.com", managedPolicyArns }, { provider })`
- Postgres sizes: dev small, prod medium/large (choose with `pulumi.getStack()`).
- EC2 families: dev t3, t4g (up to medium); prod t3, t4g, m6i, m7g, c7g, r6g.
- Log retention: at least 7 days in dev, 90 in prod.
- AWS managed policies allowed: `arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`, `arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole`, `arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore`, `arn:aws:iam::aws:policy/ReadOnlyAccess`.
- Shared infrastructure, only in its owner's directory (elsewhere use a stack reference): Vpc, Subnet, NatGateway, InternetGateway → src/network/; Key, Zone → platform/.
- Never create: `aws:organizations/*`, `aws:account/*`, `aws:iam/accountAlias:*`, `aws:iam/accountPasswordPolicy:*`, `aws:iam/samlProvider:*`, `aws:iam/openIdConnectProvider:*`.
- Resources live in src/<team>/ or platform/; `index.ts` only wires modules and exports outputs.

### Policies

- `use-platform-bucket` (**mandatory**) (checks `aws:s3/bucket:Bucket`, `aws:s3/bucketV2:BucketV2`): S3 buckets are created with the @acme/platform storage component, not the raw AWS resource. Fix: Replace the raw bucket with `new platform.storage.Bucket(name, { team, dataClass }, { provider })`.
- `use-platform-database` (**mandatory**) (checks `aws:rds/instance:Instance`, `aws:rds/cluster:Cluster`): Databases are created with the @acme/platform Postgres component, not raw RDS resources. Fix: Replace the raw RDS resource with `new platform.db.Postgres(name, { team, size, password }, { provider })`.
- `approved-platform-modules` (**mandatory**): Only supported @acme/platform modules and components are used; deprecated ones are not. Fix: Import from `@acme/platform` and use its supported components.
- `postgres-size-by-stack` (**mandatory**) (checks `acme:db:Postgres`): Platform databases use the sizes allowed for the stack: small in dev, medium or large in prod. Fix: Pick a size allowed in this stack, per stack (config), not one size for all stacks.
- `bucket-component-invariants` (**mandatory**) (checks `acme:storage:Bucket`): Every acme:storage:Bucket has a public access block, versioning and server-side encryption. Fix: Fix the component in @acme/platform so every instance gets all three children.
- `component-encapsulation` (**mandatory**): Code outside a platform component doesn't attach resources to the component's internals. Fix: Use the component's own methods or inputs instead of attaching to its children.
- `kebab-case-names` (**mandatory**): Logical resource names are kebab-case. Fix: Rename the resource to its kebab-case form.
- `physical-name-prefix` (**mandatory**): Explicit physical names start with <project>-<stack>-; otherwise leave them out for auto-naming. Fix: Remove the explicit name, or prefix it with `${pulumi.getProject()}-${pulumi.getStack()}-`.
- `deterministic-names` (**mandatory**): The program doesn't use Date.now(), Math.random() or crypto.randomUUID(): every run must declare the same resources. Fix: Use a fixed name, or a random.RandomId/RandomString resource.
- `team-ownership` (**mandatory**): Resources declared under src/<team>/ belong to that team (component `team` input, or a team tag). Fix: Set the team to the directory's team, or move the code to the owning team's directory.
- `no-resources-in-entrypoint` (advisory): The entry point (index.ts) only wires team modules together; it declares no resources. Fix: Move the resource into the owning team's module and export what index.ts needs.
- `allowed-locations` (**mandatory**): Resources are declared only under src/<team>/ or platform/ (index.ts wires modules). Fix: Move the resource into the owning team's directory.
- `forbidden-resource-types` (**mandatory**) (checks `aws:organizations/*`, `aws:account/*`, `aws:iam/accountAlias:*`, `aws:iam/accountPasswordPolicy:*`, `aws:iam/samlProvider:*`, `aws:iam/openIdConnectProvider:*`): App stacks don't create organization- or account-level resources. Fix: Remove the resource; account-level settings are managed by the platform team.
- `no-resources-in-apply` (**mandatory**): Resources are not created inside apply callbacks. Fix: Create the resource at the top level and pass the Output as its input.
- `hermetic-program` (**mandatory**): The program doesn't run processes or reach the network while it deploys. Fix: Pass the value in through stack config instead of computing it at deploy time.
- `instance-types-by-stack` (**mandatory**) (checks `aws:ec2/instance:Instance`, `aws:rds/instance:Instance`): EC2 instance types and RDS classes come from the families allowed in the stack (burstable in dev). Fix: Pick an allowed family for this stack, per stack.
- `log-retention-by-stack` (**mandatory**) (checks `aws:cloudwatch/logGroup:LogGroup`): Log groups set a retention of at least 7 days in dev and 90 in prod. Fix: Set retentionInDays per stack.
- `rds-backups-in-prod` (**mandatory**) (checks `aws:rds/instance:Instance`, `aws:rds/cluster:Cluster`): In prod, RDS instances keep backups for at least 7 days and have deletion protection on. Fix: Set backupRetentionPeriod and deletionProtection (or use platform.db.Postgres, which does).
- `cost-estimate` (advisory): A rough monthly cost per team, from a small price table, stays within the team's budget (stack config teamBudgets). Fix: Downsize the top items for this stack, or raise the team's budget in Pulumi.<stack>.yaml.
- `shared-infra-ownership` (**mandatory**) (checks `aws:ec2/vpc:Vpc`, `aws:ec2/subnet:Subnet`, `aws:ec2/natGateway:NatGateway`, `aws:ec2/internetGateway:InternetGateway`, `aws:kms/key:Key`, `aws:route53/zone:Zone`): VPCs, subnets, NAT and internet gateways belong to the network team; KMS keys and DNS zones to the platform team. Fix: Use the owning team's stack through a stack reference instead of creating your own.
- `public-lb-via-service` (**mandatory**) (checks `aws:lb/loadBalancer:LoadBalancer`, `aws:alb/loadBalancer:LoadBalancer`): Internet-facing load balancers are created only through platform.network.Service. Fix: Use `new platform.network.Service(name, { team, vpcId, port, publicSubnetIds }, { provider })`.
- `provider-region-allowed` (**mandatory**) (checks `pulumi:providers:aws`): Every explicit AWS provider's region is one of the stack's allowed regions (config allowedRegions). Fix: Use platform.provider(team), which takes the stack's region, or an allowed region.
- `no-iam-users` (**mandatory**) (checks `aws:iam/user:*`, `aws:iam/accessKey:*`, `aws:iam/userPolicy:*`, `aws:iam/userPolicyAttachment:*`, `aws:iam/userLoginProfile:*`, `aws:iam/userGroupMembership:*`): No IAM users, access keys or user policies: workloads and CI use roles. Fix: Use platform.identity.Role (for CI: an OIDC role) instead of an IAM user.
- `iam-least-privilege` (**mandatory**) (checks `aws:iam/rolePolicy:*`, `aws:iam/policy:*`, `aws:iam/userPolicy:*`, `aws:iam/groupPolicy:*`, `aws:iam/role:Role`, `aws:iam/rolePolicyAttachment:*`, `aws:iam/policyAttachment:*`, `aws:iam/userPolicyAttachment:*`, `aws:iam/groupPolicyAttachment:*`): IAM policies don't allow `*` actions or resources, and attach only approved AWS managed policies. Fix: List the actions and resource ARNs the workload needs; attach only approved managed policies.
- `role-permission-boundary` (**mandatory**) (checks `aws:iam/role:Role`): IAM roles set the company permission boundary; platform.identity.Role does it for you. Fix: Use platform.identity.Role instead of aws.iam.Role.
- `no-hardcoded-arns` (**mandatory**): Resource inputs don't contain literal ARNs (account IDs included); ARNs come from resources, config or lookups. Fix: Use the resource's `.arn` output, a stack reference, aws.getCallerIdentityOutput, or config.
- `security-review` (advisory) (checks `aws:iam/*`, `aws:ec2/securityGroup*`, `aws:ec2/vpc*`, `aws:ec2/internetGateway*`, `aws:ec2/natGateway*`, `aws:ec2/networkAcl*`, `aws:vpc/securityGroup*`, `aws:lb/loadBalancer*`, `aws:alb/loadBalancer*`): IAM and network resources declared in app code are flagged for a security review (advisory). Fix: No change needed; a reviewer from security looks at these. Prefer platform components.
- `service-definition-of-done` (**mandatory**) (checks `acme:network:Service`, `aws:lambda/function:Function`): Every service (platform.network.Service or Lambda function) has an alarm and a log group with retention. Fix: Add an aws.cloudwatch.MetricAlarm and a LogGroup with retentionInDays that reference the service.
- `required-stack-outputs` (**mandatory**): The program exports every stack output listed in the project config requiredOutputs. Fix: Export the missing outputs from index.ts.
- `protect-stateful-in-prod` (**mandatory**) (checks `acme:db:Postgres`, `acme:storage:Bucket`, `aws:rds/instance:Instance`, `aws:rds/cluster:Cluster`, `aws:s3/bucket:Bucket`, `aws:s3/bucketV2:BucketV2`, `aws:dynamodb/table:Table`): In prod, resources that hold data are protected (protect or retainOnDelete). Fix: Add `protect: pulumi.getStack() === "prod"` to the resource options.
- `secrets-stay-secret` (**mandatory**): Passwords and secret config stay secrets: in resource inputs and in how config is read. Fix: Read secret config with `config.requireSecret`/`getSecret`, and pass secrets as Outputs.
- `declared-config` (**mandatory**): Every config key the program reads is declared in Pulumi.yaml with a type and description. Fix: Declare the key under `config:` in Pulumi.yaml.
- `explicit-provider-default-tags` (**mandatory**) (checks `aws:*`): AWS resources use the team's explicit provider, which sets default tags (team, env). Fix: Pass `{ provider }` from `platform.provider(team)` to every resource.
- `no-ignore-changes-wildcard` (**mandatory**): Resources don't ignore all changes (`ignoreChanges: ["*"]`). Fix: List the specific properties another system manages, or remove ignoreChanges.
- `dependency-hygiene` (advisory): package.json pins versions (no latest or *), with supported Pulumi SDK majors. Fix: Pin a version range in package.json and commit the lockfile.
