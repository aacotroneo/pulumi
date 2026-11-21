# Agent loop run

- **before**: dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
- **after**: dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
- turns: 13, duration: 72 s, cost: $0.44, result: success

## Steps

1. Bash `find . -path ./node_modules -prune -o -type f -print | head -50`
2. Bash `for f in Pulumi.yaml Pulumi.dev.yaml Pulumi.prod.yaml PulumiScan.yaml package.json index.ts src/payments/index.ts src/se` (denied/error)
3. Bash `tail -n +1 Pulumi.yaml Pulumi.dev.yaml Pulumi.prod.yaml PulumiScan.yaml package.json index.ts src/payments/index.ts src/`
4. **scan** not run: A variable in this command can't be checked before it runs
5. **scan** dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
> Baseline scans are clean (0 findings). Now adding the bucket and database to `src/payments/index.ts` as requested, then rescanning.

6. Edit `src/payments/index.ts`
7. **scan** dev: 3 mandatory, 0 advisory (declared-config, use-platform-bucket, use-platform-database); prod: 3 mandatory, 0 advisory (declared-config, use-platform-bucket, use-platform-database)
> The guardrails require the `@acme/platform` components instead of raw `BucketV2`/`rds.Instance`, and want the config key declared. Switching to the platform components.

8. Edit `src/payments/index.ts`
9. Edit `Pulumi.yaml`
10. **scan** dev: 0 mandatory, 0 advisory; prod: 1 mandatory, 0 advisory (postgres-size-by-stack)
> Dev is clean; prod requires a `medium` or `large` database. I'll pick the size per stack (medium, the smaller of the two, in prod).

11. Edit `src/payments/index.ts`
12. **scan** dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
> I added the invoices bucket and the Postgres 16 database to `src/payments/index.ts`. Both policy scans (dev and prod) now report 0 mandatory and 0 advisory findings. To get there I had to change three things from your request, listed below.
> 
> **What changed from the request**
> 1. **Bucket:** the scan doesn't allow a raw `aws.s3.BucketV2` (`use-platform-bucket`), so I used `platform.storage.Bucket("payments-invoices")`. It adds encryption, versioning and a public-access block. I marked it `dataClass: "confidential"` and protected it in prod, the same as the existing receipts bucket, because invoi


Scans run: 8

## Final answer

I added the invoices bucket and the Postgres 16 database to `src/payments/index.ts`. Both policy scans (dev and prod) now report 0 mandatory and 0 advisory findings. To get there I had to change three things from your request, listed below.

**What changed from the request**
1. **Bucket:** the scan doesn't allow a raw `aws.s3.BucketV2` (`use-platform-bucket`), so I used `platform.storage.Bucket("payments-invoices")`. It adds encryption, versioning and a public-access block. I marked it `dataClass: "confidential"` and protected it in prod, the same as the existing receipts bucket, because invoices hold customer billing data.
2. **Database:** the scan doesn't allow a raw `aws.rds.Instance` either (`use-platform-database`), so I used `platform.db.Postgres("payments-db")`. It's private, encrypted, backed up, and protected in prod.
3. **Instance size:** you can't get db.t3.micro.
   - The platform's smallest size is `small` (db.t4g.small), and that's what dev gets.
   - The scan requires `medium` or `large` in prod (`postgres-size-by-stack`), so prod gets `medium`, which is db.r6g.large.
   - Both cost more than a t3.micro, and the prod one by a lot.

**Other edits**
- The database password comes from the secret config key `paymentsDbPassword`. As the scan requires, I declared that key in `Pulumi.yaml` as a secret string with a description.
- I exported the two new resources as `invoices` and `db` from the payments module. They aren't added to the stack outputs in the root `index.ts`.

**What a human still has to do**
- **Set the password on both stacks.** The scan ran with a placeholder value. Run `pulumi config set --secret paymentsDbPassword <value>` for dev and for prod, or deployment will fail.
- **Approve the sizes and cost.** The payments team should accept small/medium in place of t3.micro. If they really need something smaller, the platform team would have to add a size; the guardrails won't allow raw RDS.
- **Confirm the data class.** Someone should check that `confidential` is right for invoices.
- **Compile and deploy.** I couldn't run `tsc`, `npm` or a real `pulumi preview`/`up`, so the code is checked only by the mocked scan.
