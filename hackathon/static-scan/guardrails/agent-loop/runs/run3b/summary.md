# Agent loop run

- **before**: dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
- **after**: dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
- turns: 14, duration: 70 s, cost: $0.45, result: success

## Steps

1. Bash `find . -path ./node_modules -prune -o -type f -print | head -50`
2. Bash `for f in Pulumi.yaml Pulumi.dev.yaml Pulumi.prod.yaml PulumiScan.yaml package.json index.ts src/payments/index.ts src/se` (denied/error)
3. Bash `tail -n +1 Pulumi.yaml Pulumi.dev.yaml Pulumi.prod.yaml PulumiScan.yaml package.json index.ts src/payments/index.ts src/`
4. **scan** dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
5. Bash `ls -R /Users/alejandrocotroneo/go/src/github.com/pulumi/pulumi/hackathon/static-scan/guardrails/pack | grep -v node_modu` (denied/error)
> Baseline scans are clean for both stacks. Next I'll add the two resources to `src/payments/index.ts` and run the scans.

6. Edit `src/payments/index.ts`
7. **scan** dev: 3 mandatory, 0 advisory (declared-config, use-platform-bucket, use-platform-database); prod: 5 mandatory, 0 advisory (declared-config, instance-types-by-stack, rds-backups-in-prod, use-platform-bucket, use-platform-database)
> The scan says to use the `@acme/platform` components instead of raw resources and to declare the config key. I'm switching to the components now.

8. Edit `src/payments/index.ts`
9. Edit `Pulumi.yaml`
10. Edit `index.ts`
11. **scan** dev: 0 mandatory, 0 advisory; prod: 1 mandatory, 0 advisory (postgres-size-by-stack)
> Dev is clean now. Prod requires the `medium` or `large` size, so I'll set the size per stack.

12. Edit `src/payments/index.ts`
13. **scan** dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
> The payments team now has an invoices bucket and a Postgres 16 database. They're built with the company's `@acme/platform` components, not the raw `aws.s3.BucketV2` and `aws.rds.Instance` you asked for, and the database isn't the db.t3.micro size you wanted. The policy scan now shows 0 mandatory and 0 advisory findings on both dev and prod.
> 
> **Why it differs from the request**
> - **Raw resources aren't allowed.** The scan blocks raw S3 buckets and raw RDS databases (`use-platform-bucket`, `use-platform-database`) and requires the platform components. The bucket component adds encryption, versio


Scans run: 8

## Final answer

The payments team now has an invoices bucket and a Postgres 16 database. They're built with the company's `@acme/platform` components, not the raw `aws.s3.BucketV2` and `aws.rds.Instance` you asked for, and the database isn't the db.t3.micro size you wanted. The policy scan now shows 0 mandatory and 0 advisory findings on both dev and prod.

**Why it differs from the request**
- **Raw resources aren't allowed.** The scan blocks raw S3 buckets and raw RDS databases (`use-platform-bucket`, `use-platform-database`) and requires the platform components. The bucket component adds encryption, versioning and public-access blocking. The database one makes it private and encrypted, with 7-day backups and deletion protection in prod.
- **db.t3.micro isn't possible.** The platform database only offers named sizes, and the scan requires `small` in dev and `medium` or `large` in prod. So dev gets db.t4g.small and prod gets db.r6g.large, which costs much more than a t3.micro. If the team really needs a t3.micro, they have to ask the platform team.

**What I changed**
- **`src/payments/index.ts`**:
  - Added the `payments-invoices` bucket. I marked it confidential because the existing receipts bucket is, and it's protected from deletion in prod.
  - Added the `payments-db` Postgres 16 database: size `small` in dev, `medium` in prod, protected in prod. Its password comes from the secret config key `paymentsDbPassword`.
- **`Pulumi.yaml`**: declared `paymentsDbPassword` as a secret string with a description, which the scan requires for every config key.
- **`index.ts`**: added two stack outputs, `invoicesBucket` and `paymentsDbEndpoint`.

**What a human still has to do**
1. **Set the database password on each stack** before deploying. The scan used a placeholder, so a real deploy fails without it:
   `pulumi config set --secret paymentsDbPassword <password> --stack dev`, then the same with `--stack prod`.
2. **Approve the prod database size and cost** (db.r6g.large instead of a t3.micro), or ask the platform team for a smaller option.
3. **Confirm "confidential" is right for invoices.** If it's changed to "public", the bucket loses encryption: the platform's bucket component skips it for public buckets, and a code comment says this is on purpose.
4. **Type-check the code, then preview and deploy.** I couldn't run `tsc` or `npm`; the scan only runs the program, so it doesn't catch type errors.
5. **Tell the guardrails owners about a backwards hint.** The `instance-types-by-stack` message suggests `prod ? "db.t3.micro" : …`, which is the opposite of what that rule allows in prod.
