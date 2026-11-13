| program | status | resources | findings | can't decide | stubs | cold s | warm s | error |
|---|---|---|---|---|---|---|---|---|
| aws-ts-ai-app-infrastructure | ok | 8 | 39 | 0 |  | 0.87 | 0.87 |  |
| aws-ts-airflow | ok | 83 | 398 | 24 |  | 2.03 | 1.84 |  |
| aws-ts-ansible-wordpress | error | 0 | 0 | 0 |  | 0.86 | 0.76 | Error: ENOENT: no such file or directory, open '[missing config pulumi-ansible-wordpress-ts:publicKeyPath]' |
| aws-ts-apigateway | ok | 7 | 42 | 0 |  | 0.94 | 0.84 |  |
| aws-ts-apigateway-auth0 | error | 0 | 0 | 0 | jsonwebtoken, jwks-rsa | 1.0 | 0.84 | TypeError: Cannot read properties of undefined (reading 'API') |
| aws-ts-apigateway-eventbridge | ok | 19 | 63 | 0 |  | 1.0 | 0.98 |  |
| aws-ts-apigateway-lambda-serverless | ok | 35 | 87 | 0 |  | 1.17 | 1.11 |  |
| aws-ts-apigatewayv2-eventbridge | ok | 13 | 55 | 0 |  | 0.99 | 0.99 |  |
| aws-ts-apigatewayv2-http-api | ok | 9 | 48 | 0 |  | 0.9 | 0.88 |  |
| aws-ts-apigatewayv2-http-api-quickcreate | ok | 6 | 44 | 0 |  | 0.89 | 0.98 |  |
| aws-ts-appsync | ok | 11 | 35 | 25 |  | 1.03 | 0.99 |  |
| aws-ts-containers | ok | 6 | 9 | 0 |  | 1.0 | 1.2 |  |
| aws-ts-containers-dockerbuild | ok | 6 | 9 | 0 |  | 1.26 | 0.99 |  |
| aws-ts-containers-dockerbuildcloud | ok | 6 | 9 | 0 |  | 0.94 | 0.94 |  |
| aws-ts-ec2-provisioners | error | 0 | 0 | 0 |  | 0.79 | 0.77 | Error: must provide one of `keyName` or `publicKey` |
| aws-ts-ecr-cache | ok | 3 | 21 | 0 |  | 0.79 | 0.77 |  |
| aws-ts-ecs-anywhere | ok | 19 | 97 | 0 |  | 1.35 | 1.1 |  |
| aws-ts-eks | ok | 3 | 0 | 0 |  | 1.32 | 0.98 |  |
| aws-ts-eks-distro | ok | 5 | 50 | 0 | mustache, tmp | 0.99 | 0.82 |  |
| aws-ts-eks-gpu-dra | ok | 32 | 18 | 0 |  | 1.49 | 1.32 |  |
| aws-ts-eks-hello-world | error | 3 | 0 | 0 |  | 1.32 | 1.05 | the program did not finish: it waits on a value that is only known after deployment |
| aws-ts-eks-migrate-nodegroups | error | 18 | 27 | 0 |  | 1.48 | 1.44 | the program did not finish: it waits on a value that is only known after deployment |
| aws-ts-esc-external-adapter-lambda | ok | 5 | 29 | 0 | jsonwebtoken, jwks-rsa | 0.87 | 0.83 |  |
| aws-ts-hello-fargate | ok | 36 | 144 | 8 |  | 1.34 | 1.17 |  |
| aws-ts-k8s-mern-voting-app | error | 7 | 17 | 0 |  | 1.23 | 1.15 | the program did not finish: it waits on a value that is only known after deployment |
| aws-ts-k8s-voting-app | error | 7 | 17 | 0 |  | 1.63 | 1.47 | the program did not finish: it waits on a value that is only known after deployment |
| aws-ts-lambda-efs | error | 3 | 15 | 0 | @pulumiverse/time | 1.41 | 1.06 | Error: error serializing property "routes": 'dependsOn' was passed a value that was not a Resource. |
| aws-ts-lambda-secrets | ok | 6 | 41 | 16 |  | 0.9 | 0.82 |  |
| aws-ts-lambda-slack | ok | 10 | 48 | 0 |  | 0.88 | 0.93 |  |
| aws-ts-lambda-thumbnailer | ok | 14 | 111 | 0 |  | 1.12 | 1.02 |  |
| aws-ts-landing-zone | ok | 18 | 84 | 22 |  | 1.27 | 1.03 |  |
| aws-ts-langserve | ok | 27 | 226 | 7 |  | 1.24 | 1.15 |  |
| aws-ts-localai-flowise | ok | 15 | 52 | 13 |  | 1.32 | 1.1 |  |
| aws-ts-multi-language-lambda | ok | 10 | 89 | 0 |  | 0.97 | 1.0 |  |
| aws-ts-nextjs | ok | 20 | 167 | 0 | glob | 13.13 | 8.34 |  |
| aws-ts-oidc-provider-pulumi-cloud | ok | 5 | 9 | 9 |  | 0.99 | 0.81 |  |
| aws-ts-organizations | ok | 26 | 104 | 9 |  | 1.16 | 1.07 |  |
| aws-ts-pern-voting-app | ok | 22 | 174 | 4 |  | 1.45 | 1.18 |  |
| aws-ts-production-observability | ok | 12 | 45 | 0 |  | 1.0 | 0.98 |  |
| aws-ts-pulumi-miniflux | ok | 8 | 92 | 0 |  | 1.08 | 0.97 |  |
| aws-ts-pulumi-webhooks | ok | 29 | 78 | 0 | @slack/webhook | 1.27 | 1.26 |  |
| aws-ts-redshift-glue-etl | ok | 16 | 168 | 0 |  | 0.98 | 0.97 |  |
| aws-ts-resources | ok | 29 | 210 | 4 |  | 1.12 | 1.14 |  |
| aws-ts-ruby-on-rails | error | 0 | 0 | 0 |  | 0.74 | 0.87 | Error: dbUser must between 1-16 characters, inclusively |
| aws-ts-s3-folder | ok | 7 | 80 | 0 |  | 0.87 | 0.85 |  |
| aws-ts-s3-folder-component | ok | 8 | 80 | 0 |  | 0.87 | 0.95 |  |
| aws-ts-s3-lambda-copyzip | ok | 16 | 129 | 0 |  | 0.99 | 0.91 |  |
| aws-ts-scheduled-function | ok | 17 | 79 | 0 | aws-sdk/clients/s3 | 0.93 | 0.94 |  |
| aws-ts-secrets-manager | ok | 3 | 6 | 0 |  | 0.76 | 0.77 |  |
| aws-ts-serverless-datawarehouse | ok | 58 | 274 | 0 | aws-sdk, moment-timezone | 1.51 | 1.51 |  |
| aws-ts-serverless-raw | ok | 9 | 69 | 15 |  | 0.92 | 0.99 |  |
| aws-ts-serverless-react-postgres | ok | 26 | 121 | 22 |  | 1.19 | 1.14 |  |
| aws-ts-slackbot | ok | 29 | 81 | 0 |  | 1.09 | 1.08 |  |
| aws-ts-static-website | error | 0 | 0 | 0 |  | 0.89 | 0.87 | Error: No TLD found on [missing config aws-ts-static-website:targetDomain] |
| aws-ts-stepfunctions | ok | 8 | 71 | 0 |  | 0.88 | 0.9 |  |
| aws-ts-synthetics-canary | ok | 8 | 119 | 0 |  | 0.9 | 0.92 |  |
| aws-ts-thumbnailer | ok | 44 | 208 | 8 |  | 1.42 | 1.31 |  |
| aws-ts-twitter-athena | ok | 21 | 82 | 0 |  | 0.97 | 1.02 |  |
| aws-ts-voting-app | ok | 7 | 0 | 0 |  | 0.96 | 1.03 |  |
| aws-ts-webserver | ok | 3 | 51 | 0 |  | 0.85 | 0.78 |  |
| aws-ts-wordpress-fargate-rds | ok | 24 | 213 | 7 |  | 1.16 | 1.18 |  |
