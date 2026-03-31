import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { AppConfig } from "./config";

// Parse an S3 URI into bucket and prefix.
// The returned prefix always ends with "/" if non-empty, or is "" if the URI has no prefix.
// Examples:
//   "s3://bucket/apt/"  -> { bucket: "bucket", prefix: "apt/" }
//   "s3://bucket/apt"   -> { bucket: "bucket", prefix: "apt/" }
//   "s3://bucket/"      -> { bucket: "bucket", prefix: "" }
//   "s3://bucket"       -> { bucket: "bucket", prefix: "" }
export function parseS3Uri(uri: string): { bucket: string; prefix: string } {
    const normalized = uri.endsWith("/") ? uri : uri + "/";
    const match = normalized.match(/^s3:\/\/([^/]+)\/(.*)$/);
    if (!match) throw new Error(`Invalid S3 URI: "${uri}"`);
    return { bucket: match[1], prefix: match[2] };
}

export interface StorageResult {
    bucket: aws.s3.Bucket;
    logsBucket?: aws.s3.Bucket;
}

export function createStorage(cfg: AppConfig): StorageResult {
    const { bucket: bucketName, prefix: s3Prefix } = parseS3Uri(cfg.s3Uri);

    const logsInfo = cfg.accessLogsS3Uri ? parseS3Uri(cfg.accessLogsS3Uri) : undefined;
    const sharedBucket = logsInfo !== undefined && logsInfo.bucket === bucketName;

    // Verify that prefixes don't overlap when sharing the same bucket
    if (sharedBucket) {
        const aptPfx  = s3Prefix;
        const logsPfx = logsInfo!.prefix;
        if (logsPfx.startsWith(aptPfx) || aptPfx.startsWith(logsPfx)) {
            throw new Error(
                `aptAwscliV2:s3Uri ("${cfg.s3Uri}") and aptAwscliV2:accessLogsS3Uri ("${cfg.accessLogsS3Uri}") ` +
                `share the same bucket but their prefixes overlap ` +
                `("${aptPfx}" vs "${logsPfx}"). Use mutually exclusive prefixes (e.g., "apt/" and "logs/").`,
            );
        }
    }

    // ─── S3 Bucket ────────────────────────────────────────────────────────────

    const bucket = new aws.s3.Bucket(bucketName, {
        bucket: bucketName,
    });

    // ─── Public Access Block ──────────────────────────────────────────────────
    // Disable all public-access blocks so the bucket policy can allow public reads.

    const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(`${bucketName}-public-access-block`, {
        bucket: bucket.id,
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
    });

    // ─── Bucket Policy ────────────────────────────────────────────────────────
    // GetObject on ${bucket}/${s3Prefix}*  (public read of APT files)
    // + PutObject for logging service if logs are stored in the same bucket (sharedBucket)

    new aws.s3.BucketPolicy(`${bucketName}-policy`, {
        bucket: bucket.id,
        policy: pulumi.all([bucket.id, aws.getCallerIdentityOutput().accountId])
            .apply(([id, accountId]) => {
                const statements: object[] = [{
                    Sid: "PublicReadGetObject",
                    Effect: "Allow",
                    Principal: "*",
                    Action: "s3:GetObject",
                    Resource: `arn:aws:s3:::${id}/${s3Prefix}*`,
                }];
                if (sharedBucket) {
                    statements.push({
                        Sid: "S3ServerAccessLogsPolicy",
                        Effect: "Allow",
                        Principal: { Service: "logging.s3.amazonaws.com" },
                        Action: "s3:PutObject",
                        Resource: `arn:aws:s3:::${id}/${logsInfo!.prefix}*`,
                        Condition: {
                            StringEquals: { "aws:SourceAccount": accountId },
                        },
                    });
                }
                return JSON.stringify({ Version: "2012-10-17", Statement: statements });
            }),
    }, { dependsOn: [publicAccessBlock] });

    // ─── Access Logs Bucket ───────────────────────────────────────────────────

    let logsBucket: aws.s3.Bucket | undefined;

    if (logsInfo) {
        const { bucket: lbn, prefix: logsPrefix } = logsInfo;

        if (sharedBucket) {
            // Share the same bucket as s3Uri
            logsBucket = bucket;

            // Disable ACL (BucketOwnerEnforced) — required for policy-based log delivery
            new aws.s3.BucketOwnershipControls(`${lbn}-ownership`, {
                bucket: bucket.id,
                rule: { objectOwnership: "BucketOwnerEnforced" },
            });
        } else {
            logsBucket = new aws.s3.Bucket(lbn, { bucket: lbn });

            // Fully private
            new aws.s3.BucketPublicAccessBlock(`${lbn}-public-access-block`, {
                bucket: logsBucket.id,
                blockPublicAcls:       true,
                blockPublicPolicy:     true,
                ignorePublicAcls:      true,
                restrictPublicBuckets: true,
            });

            // Disable ACL (BucketOwnerEnforced) — required for policy-based log delivery
            new aws.s3.BucketOwnershipControls(`${lbn}-ownership`, {
                bucket: logsBucket.id,
                rule: { objectOwnership: "BucketOwnerEnforced" },
            });

            // Allow PutObject for logging.s3.amazonaws.com
            new aws.s3.BucketPolicy(`${lbn}-policy`, {
                bucket: logsBucket.id,
                policy: pulumi.all([logsBucket.id, aws.getCallerIdentityOutput().accountId])
                    .apply(([id, accountId]) => JSON.stringify({
                        Version: "2012-10-17",
                        Statement: [{
                            Sid: "S3ServerAccessLogsPolicy",
                            Effect: "Allow",
                            Principal: { Service: "logging.s3.amazonaws.com" },
                            Action: "s3:PutObject",
                            Resource: `arn:aws:s3:::${id}/${logsPrefix}*`,
                            Condition: {
                                StringEquals: { "aws:SourceAccount": accountId },
                            },
                        }],
                    })),
            });
        }

        // Lifecycle (only when accessLogRetentionDays != -1)
        if (cfg.accessLogRetentionDays !== -1) {
            new aws.s3.BucketLifecycleConfigurationV2(`${lbn}-lifecycle`, {
                bucket: logsBucket.id,
                rules: [{
                    id: "expire-access-logs",
                    status: "Enabled",
                    // For shared buckets, target only the logs prefix to prevent accidental deletion of APT files
                    ...(sharedBucket ? { filter: { prefix: logsPrefix } } : {}),
                    expiration: { days: cfg.accessLogRetentionDays },
                }],
            });
        }

        // Enable logging on the main bucket
        new aws.s3.BucketLogging(`${bucketName}-logging`, {
            bucket: bucket.id,
            targetBucket: logsBucket.id,
            targetPrefix: logsPrefix,
            targetObjectKeyFormat: {
                partitionedPrefix: {
                    partitionDateSource: "EventTime",
                },
            },
        });
    }

    return { bucket, logsBucket };
}
