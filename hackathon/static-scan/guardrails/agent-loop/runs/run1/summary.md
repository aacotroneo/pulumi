# Agent loop run

- **before**: dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
- **after**: dev: 0 mandatory, 0 advisory; prod: 0 mandatory, 0 advisory
- turns: 12, duration: 59 s, cost: $0.35, result: success

## Steps

1. Bash `find . -not -path './node_modules*' -type f | head -50`
2. Bash `for f in Pulumi.yaml Pulumi.dev.yaml Pulumi.prod.yaml PulumiScan.yaml package.json index.ts src/payments/index.ts src/se` (denied/error)
3. Bash `tail -n +1 Pulumi.yaml Pulumi.dev.yaml Pulumi.prod.yaml PulumiScan.yaml package.json index.ts src/payments/index.ts src/`
> Let me run the baseline scans first.

4. **scan** not run: This Bash command contains multiple operations. The following part requires approval: echo "--- exit
5. **scan** dev: 0 mandatory, 0 advisory
6. **scan** prod: 0 mandatory, 0 advisory
7. Write `src/payments/index.ts`
8. Edit `index.ts`
9. Edit `Pulumi.yaml`
10. **scan** dev: 0 mandatory, 0 advisory
11. **scan** prod: 0 mandatory, 0 advisory
> I added the invoices bucket and the Postgres database to the payments team's code. The dev and prod policy scans both report 0 mandatory and 0 advisory findings. The resource count went from 23 to 30, which matches the two new components.
> 
> **What I changed**
> - **`src/payments/index.ts`**
>   - **Invoices bucket:** `payments-invoices` uses the platform's standard bucket. I marked it `confidential` because invoices are financial data, and it's protected in prod like the existing receipts bucket. That class also gets it encryption.
>   - **Database:** `payments-db` uses the platform's standard Postgr


Scans run: 4

## Final answer

I added the invoices bucket and the Postgres database to the payments team's code. The dev and prod policy scans both report 0 mandatory and 0 advisory findings. The resource count went from 23 to 30, which matches the two new components.

**What I changed**
- **`src/payments/index.ts`**
  - **Invoices bucket:** `payments-invoices` uses the platform's standard bucket. I marked it `confidential` because invoices are financial data, and it's protected in prod like the existing receipts bucket. That class also gets it encryption.
  - **Database:** `payments-db` uses the platform's standard Postgres, which is private, encrypted and backed up. It's `small` in dev, `medium` in prod, and protected in prod. The master password comes from a secret config key, `paymentsDbPassword`. All of this copies how the search team's database is set up.
  - Both use the payments team's AWS provider.
- **`index.ts`:** exports `invoicesBucket` and `paymentsDbEndpoint`.
- **`Pulumi.yaml`:** declares `paymentsDbPassword` as a secret string with a description.

**What a human still has to do**
1. **Set the database password for both stacks.** I couldn't run `pulumi config`, and the scans only passed because they filled in a placeholder password. Until these are set, a real deploy will fail:
   ```
   pulumi config set --secret paymentsDbPassword <password> --stack dev
   pulumi config set --secret paymentsDbPassword <password> --stack prod
   ```
2. **Check the choices I made for you:** confidential for invoices, and the medium prod size copied from search. Change either if the payments team needs something else.
3. **Run `npm install`/`tsc` and `pulumi preview`/`up` on both stacks.** I couldn't run them here, and the scan only uses mocks, so it doesn't test a real deployment.
4. **Plan for deletion in prod.** Both new resources are protected there, so removing either later means taking the protection off first.
