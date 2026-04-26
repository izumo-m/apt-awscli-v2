import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { AppConfig } from "./config";

// ─── Lambda IAM ───────────────────────────────────────────────────────────────

export interface LambdaIamResult {
    lambdaRole: aws.iam.Role;
    lambdaRolePolicy: aws.iam.RolePolicy;
}

function parseBucketName(s3Uri: string): string {
    const match = s3Uri.match(/^s3:\/\/([^/]+)/);
    if (!match) throw new Error(`Invalid S3 URI: "${s3Uri}"`);
    return match[1];
}

export function createLambdaIam(cfg: AppConfig): LambdaIamResult {
    const roleName     = `${cfg.resourcePrefix}-lambda-role`;
    const policyName   = `${cfg.resourcePrefix}-lambda-policy`;
    const lambdaName   = `${cfg.resourcePrefix}-lambda`;
    const logGroupName = `/aws/lambda/${lambdaName}`;
    const bucketName   = parseBucketName(cfg.s3Uri);

    // ─── IAM Role ─────────────────────────────────────────────────────────────

    const lambdaRole = new aws.iam.Role(roleName, {
        name: roleName,
        assumeRolePolicy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Principal: { Service: "lambda.amazonaws.com" },
                    Action: "sts:AssumeRole",
                },
            ],
        }),
    });

    // ─── IAM Inline Policy ────────────────────────────────────────────────────
    // Resources follow the principle of least privilege, limited to specific ARNs.
    // - S3: Separate bucket ARN (for ListBucket) and bucket/* (for object operations)
    // - SSM: Specific parameter ARN only
    // - KMS: Only the alias ARN for the aws/ssm managed key used by SSM
    // - Logs: CreateLogGroup removed since Pulumi manages it. Limited to specific log group ARN.
    //
    // region / accountId are resolved dynamically via apply().

    const region    = aws.getRegionOutput().name;
    const accountId = aws.getCallerIdentityOutput().accountId;

    const policy = pulumi.all([region, accountId]).apply(([r, acct]) => {
        // SSM parameters the Lambda may read. Cloudflare credentials are added
        // only when configured, so deployments without Cloudflare integration
        // get no extra permissions.
        const ssmParameterArns: string[] = [
            `arn:aws:ssm:${r}:${acct}:parameter${cfg.ssmParamName}`,
        ];
        if (cfg.cloudflareSsmParam) {
            ssmParameterArns.push(`arn:aws:ssm:${r}:${acct}:parameter${cfg.cloudflareSsmParam}`);
        }

        return JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                    Resource: `arn:aws:s3:::${bucketName}/*`,
                },
                {
                    Effect: "Allow",
                    Action: "s3:ListBucket",
                    Resource: `arn:aws:s3:::${bucketName}`,
                },
                {
                    Effect: "Allow",
                    Action: "ssm:GetParameter",
                    Resource: ssmParameterArns,
                },
                {
                    Effect: "Allow",
                    Action: "kms:Decrypt",
                    Resource: `arn:aws:kms:${r}:${acct}:alias/aws/ssm`,
                },
                {
                    Effect: "Allow",
                    Action: [
                        "logs:CreateLogStream",
                        "logs:PutLogEvents",
                    ],
                    Resource: `arn:aws:logs:${r}:${acct}:log-group:${logGroupName}:*`,
                },
            ],
        });
    });

    const lambdaRolePolicy = new aws.iam.RolePolicy(policyName, {
        name: policyName,
        role: lambdaRole.id,
        policy,
    });

    return { lambdaRole, lambdaRolePolicy };
}

// ─── Scheduler IAM ────────────────────────────────────────────────────────────

export interface SchedulerIamResult {
    schedulerRole: aws.iam.Role;
}

export function createSchedulerIam(args: {
    prefix: string;
    lambdaArn: pulumi.Output<string>;
}): SchedulerIamResult {
    const { prefix, lambdaArn } = args;
    const schedulerRoleName   = `${prefix}-scheduler-role`;
    const schedulerPolicyName = `${prefix}-scheduler-policy`;

    // Confused Deputy prevention: restrict role assumption to the scheduler service
    // within the same account using the aws:SourceAccount condition.
    const accountId = aws.getCallerIdentityOutput().accountId;

    const schedulerRole = new aws.iam.Role(schedulerRoleName, {
        name: schedulerRoleName,
        assumeRolePolicy: accountId.apply(acct => JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Principal: { Service: "scheduler.amazonaws.com" },
                    Action: "sts:AssumeRole",
                    Condition: {
                        StringEquals: { "aws:SourceAccount": acct },
                    },
                },
            ],
        })),
    });

    new aws.iam.RolePolicy(schedulerPolicyName, {
        name: schedulerPolicyName,
        role: schedulerRole.id,
        policy: lambdaArn.apply(arn => JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: "lambda:InvokeFunction",
                    Resource: arn,
                },
            ],
        })),
    });

    return { schedulerRole };
}
