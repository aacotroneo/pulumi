# Agent loop run

- **before**: dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
- **after**: dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
- turns: 10, duration: 49 s, cost: $0.39, result: success

## Steps

1. Bash `find . -path ./node_modules -prune -o -type f -print | head -50`
2. Bash `for f in CLAUDE.md Pulumi.yaml Pulumi.dev.yaml Pulumi.prod.yaml PulumiScan.yaml package.json index.ts src/payments/index` (denied/error)
3. Bash `tail -n +1 CLAUDE.md Pulumi.yaml Pulumi.dev.yaml Pulumi.prod.yaml PulumiScan.yaml package.json index.ts src/payments/ind`
> The policies require the platform components instead of raw `aws.s3.BucketV2` / `aws.rds.Instance`, so I'll use `platform.storage.Bucket` and `platform.db.Postgres`. First, a baseline scan:

4. **scan** not run: A variable in this command can't be checked before it runs
5. **scan** dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
> Clean baseline. Now the change:

6. Edit `src/payments/index.ts`
7. Edit `Pulumi.yaml`
8. Edit `index.ts`
9. **scan** dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
> I added both resources to `src/payments/index.ts`. The final dev and prod scans both report 0 mandatory and 0 advisory findings. Midway through, a hook flagged the new password config key as undeclared because it ran before my `Pulumi.yaml` edit landed; the later scans were clean.
> 
> **I didn't use the exact resources you asked for.** The mandatory policies `use-platform-bucket` and `use-platform-database` don't allow raw `aws.s3.BucketV2` or `aws.rds.Instance`. So I used the company's approved components, `platform.storage.Bucket` and `platform.db.Postgres`.
> 
> **Changes:**
> - **`src/payments/inde


Scans run: 4

## Final answer

I added both resources to `src/payments/index.ts`. The final dev and prod scans both report 0 mandatory and 0 advisory findings. Midway through, a hook flagged the new password config key as undeclared because it ran before my `Pulumi.yaml` edit landed; the later scans were clean.

**I didn't use the exact resources you asked for.** The mandatory policies `use-platform-bucket` and `use-platform-database` don't allow raw `aws.s3.BucketV2` or `aws.rds.Instance`. So I used the company's approved components, `platform.storage.Bucket` and `platform.db.Postgres`.

**Changes:**
- **`src/payments/index.ts`**:
  - **`payments-invoices`** is the new bucket, marked confidential. It comes with public access blocked, versioning and encryption, and is protected from deletion in prod.
  - **`payments-db`** is the new Postgres 16 database. It is size small in dev and medium in prod, which is what the guardrails allow. Its password is read as a secret from config, and it is protected in prod, where the component also turns on deletion protection and 7-day backups.
- **`Pulumi.yaml`**: declared the `paymentsDbPassword` config key as a secret string with a description, which the `declared-config` policy requires.
- **`index.ts`**: added two stack outputs, `invoicesBucket` and `paymentsDbEndpoint`.

**What a human still has to do:**
1. **Set the database password for each stack**, which I couldn't do here: `pulumi config set --secret paymentsDbPassword <value> --stack dev`, then the same with `--stack prod`. The scan ran on a placeholder, and a real deploy will fail until this is set.
2. **Accept the instance size, or get it changed.** You can't get `db.t3.micro` through the component. It uses `db.t4g.small` in dev and `db.r6g.large` in prod, which costs a lot more than a micro. If payments really needs a micro, the platform team would have to add a size; the guardrails don't allow raw RDS.
3. **Check the engine version.** The component pins Postgres 16.4, so the version comes from the platform rather than payments.
4. **Optionally, tell the platform team about a bug I found.** `platform/storage.ts` skips encryption for buckets marked `"public"`. It doesn't affect the invoices bucket, since that one is confidential.
5. **Run a real preview and deploy.** The scan used mocks, so nothing has been type-checked (`tsc`) or previewed yet.
