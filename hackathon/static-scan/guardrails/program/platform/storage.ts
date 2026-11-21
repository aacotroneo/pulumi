import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export type DataClass = "public" | "internal" | "confidential";

export interface BucketArgs {
    /** The owning team; it must match the `src/<team>/` directory the bucket is declared in. */
    team: string;
    /** What the bucket holds. Confidential buckets must be protected in prod. */
    dataClass: DataClass;
}

/**
 * An S3 bucket with Acme's defaults: public access blocked, versioning on, server-side encryption, tags.
 */
export class Bucket extends pulumi.ComponentResource {
    public readonly bucket: aws.s3.Bucket;
    public readonly arn: pulumi.Output<string>;
    public readonly bucketName: pulumi.Output<string>;

    constructor(name: string, args: BucketArgs, opts?: pulumi.ComponentResourceOptions) {
        super("acme:storage:Bucket", name, args, opts);
        const tags = { team: args.team, "data-class": args.dataClass };
        this.bucket = new aws.s3.Bucket(name, { tags }, { parent: this });
        new aws.s3.BucketPublicAccessBlock(
            `${name}-public-access`,
            {
                bucket: this.bucket.id,
                blockPublicAcls: true,
                blockPublicPolicy: true,
                ignorePublicAcls: true,
                restrictPublicBuckets: true,
            },
            { parent: this },
        );
        new aws.s3.BucketVersioning(
            `${name}-versioning`,
            { bucket: this.bucket.id, versioningConfiguration: { status: "Enabled" } },
            { parent: this },
        );
        // Bug, on purpose (the showcase's component-implementation finding): public buckets skip encryption.
        if (args.dataClass !== "public") {
            new aws.s3.BucketServerSideEncryptionConfiguration(
                `${name}-encryption`,
                {
                    bucket: this.bucket.id,
                    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "aws:kms" }, bucketKeyEnabled: true }],
                },
                { parent: this },
            );
        }
        this.arn = this.bucket.arn;
        this.bucketName = this.bucket.bucket;
        this.registerOutputs({ arn: this.arn, bucketName: this.bucketName });
    }
}
