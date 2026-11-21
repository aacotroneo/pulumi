# Agent loop run

- **before**: dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
- **after**: dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
- turns: 12, duration: 60 s, cost: $0.35, result: success

## Steps

1. Bash `find . -path ./node_modules -prune -o -type f -print | head -50`
2. Bash `for f in Pulumi.yaml Pulumi.dev.yaml Pulumi.prod.yaml PulumiScan.yaml package.json index.ts src/payments/index.ts src/se` (denied/error)
3. Bash `tail -n +1 Pulumi.yaml Pulumi.dev.yaml Pulumi.prod.yaml PulumiScan.yaml package.json index.ts src/payments/index.ts src/`
4. Edit `src/payments/index.ts`
5. Edit `index.ts`
6. **scan** not run: This Bash command contains multiple operations. The following part requires approval: echo "EXIT $?"
> I've added the invoices bucket and Postgres DB to `src/payments/index.ts`; now running the policy scans.

7. **scan** dev: 1 mandatory, 0 advisory (declared-config)
8. **scan** prod: 1 mandatory, 0 advisory (declared-config)
9. Edit `Pulumi.yaml`
10. **scan** dev: 0 mandatory, 0 advisory
11. **scan** prod: 0 mandatory, 0 advisory
> I added the invoices bucket and the Postgres database to the payments team's code. The policy scan now passes on both `dev` and `prod` with no findings at all, mandatory or advisory. The scan runs with mocks, so nothing has been deployed or compiled for real.
> 
> **What I changed**
> 
> - **`src/payments/index.ts`**:
>   - **Invoices bucket:** added `payments-invoices` using the company's standard bucket component. I marked it `confidential`, like the existing receipts bucket, and it's protected from deletion in prod.
>   - **Database:** added `payments-db` using the company's standard Postgres component


Scans run: 4

## Final answer

I added the invoices bucket and the Postgres database to the payments team's code. The policy scan now passes on both `dev` and `prod` with no findings at all, mandatory or advisory. The scan runs with mocks, so nothing has been deployed or compiled for real.

**What I changed**

- **`src/payments/index.ts`**:
  - **Invoices bucket:** added `payments-invoices` using the company's standard bucket component. I marked it `confidential`, like the existing receipts bucket, and it's protected from deletion in prod.
  - **Database:** added `payments-db` using the company's standard Postgres component. It's `small` in dev and `medium` in prod, and protected from deletion in prod. Its password comes from a secret config value, `paymentsDbPassword`.
- **`index.ts`**: the stack now outputs `invoicesBucket` and `paymentsDbEndpoint`.
- **`Pulumi.yaml`**: declared the `paymentsDbPassword` setting as a secret string with a description. The first scan flagged it as undeclared; that was the only finding, and this fixed it.

**What a human still has to do**

1. **Set the database password on each stack** before deploying. The scan used a placeholder because it isn't set:
   ```
   pulumi config set --secret paymentsDbPassword <password> --stack dev
   pulumi config set --secret paymentsDbPassword <password> --stack prod
   ```
2. **Confirm my choices**: that invoices count as `confidential`, and that `medium` (`db.r6g.large`) is the right prod size rather than `large`.
3. **Check the type-check and a real preview**: run `npm install`, then `tsc`, then `pulumi preview` on both stacks. I wasn't allowed to run them.
4. **Decide where the database's network lives.** The Postgres component never says which network (VPC) or subnets the database goes in, so AWS will put it in the account's default VPC. It isn't publicly reachable, but the platform team should confirm that's acceptable, or add network settings to `platform/db.ts`.
