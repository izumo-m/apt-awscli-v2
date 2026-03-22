import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as command from "@pulumi/command";
import { AppConfig } from "./config";
import { watchedFiles, computeSourceHash } from "./lambdaSource";

// ─── Lambda ───────────────────────────────────────────────────────────────────

export interface LambdaResult {
    lambdaFn: aws.lambda.Function;
    logGroup: aws.cloudwatch.LogGroup;
}

export function createLambda(
    cfg: AppConfig,
    lambdaRole: aws.iam.Role,
    lambdaRolePolicy: aws.iam.RolePolicy,
): LambdaResult {

    const lambdaName   = `${cfg.resourcePrefix}-lambda`;
    const logGroupName = `/aws/lambda/${lambdaName}`;

    // ─── CloudWatch Log Group ─────────────────────────────────────────────────

    const logGroup = new aws.cloudwatch.LogGroup(`${lambdaName}-log-group`, {
        name: logGroupName,
        retentionInDays: cfg.logRetentionDays,
    });

    // ─── Build Lambda ─────────────────────────────────────────────────────────
    // Compute the source file hash at Pulumi program evaluation time.
    // The hash includes lambdaArch, so changing architecture also changes the hash.
    // @pulumi/command only runs the build when the hash changes.
    //
    // Hash computation uses relative paths from lambdaDir as baseDir (via path.relative in computeSourceHash).
    // This ensures hash values are consistent across user environments.
    // lambdaDir itself is an absolute path based on __dirname, so it doesn't depend on the working directory.
    const lambdaDir = path.resolve(__dirname, "../../lambda");

    const watchedFileList = watchedFiles(lambdaDir);
    const sourceHash      = computeSourceHash(watchedFileList, lambdaDir, [cfg.lambdaArch]);


    const lambdaEnvVars: Record<string, string> = {
        APT_AWSCLI_V2_S3_URL:       cfg.s3Uri,
        APT_AWSCLI_V2_SSM_PARAM:    cfg.ssmParamName,
        APT_AWSCLI_V2_EMAIL:        cfg.email,
        APT_AWSCLI_V2_NAME:         cfg.maintainerName,
        APT_AWSCLI_V2_ARCHS:        cfg.aptArches.join(","),
        APT_AWSCLI_V2_PACKAGES:     cfg.aptPackages.join(","),
        APT_AWSCLI_V2_MAX_VERSIONS: String(cfg.maxVersions),
        APT_AWSCLI_V2_THREADS:      String(cfg.lambdaThreads),
        APT_AWSCLI_V2_ZSTD_THREADS: String(cfg.lambdaZstdThreads),
        APT_AWSCLI_V2_ZSTD_LEVEL:   String(cfg.lambdaZstdLevel),
    };

    // ─── Lambda Function ──────────────────────────────────────────────────────
    // Use an AssetArchive with embedded sourceHash for the code property, fixed with ignoreChanges.
    // Actual code deployment is handled by the lambdaCode Command (aws lambda update-function-code).
    // This prevents code diffs from appearing in preview even after rm -fr pulumi.out.
    // Non-code changes like memorySize, timeout, and environment variables are tracked by this resource.
    const lambdaFn = new aws.lambda.Function(lambdaName, {
        name: lambdaName,
        runtime: "provided.al2023",
        architectures: [cfg.lambdaArch],
        code: new pulumi.asset.AssetArchive({
            ".source-hash": new pulumi.asset.StringAsset(sourceHash),
        }),
        handler: "bootstrap",
        role: lambdaRole.arn,
        memorySize: cfg.lambdaMemorySize,
        timeout: cfg.lambdaTimeout,
        ephemeralStorage: { size: cfg.lambdaEphemeralStorage },
        environment: { variables: lambdaEnvVars },
    }, {
        ignoreChanges: ["code"],  // Don't let Pulumi track code since the lambdaCode Command manages it
        dependsOn: [lambdaRole, lambdaRolePolicy, logGroup],
    });

    // ─── Lambda Code ─────────────────────────────────────────────────────────
    // Deploy code when sourceHash or arch changes.
    // Build is already done by npm run up via checkAndBuild() (src/check-and-build.ts).
    // Runs with the assumption that lambdaFn exists (dependsOn).
    // The update-lambda-code.ts script performs the actual deployment (via AWS SDK).
    // The script is invoked via ts-node. cwd is pulumi/src/, so ../ references pulumi/.
    // BUILD_OUTPUT_HASH and APT_AWSCLI_V2_LAMBDA_NAME are passed via environment.
    const codeCmd = `../node_modules/.bin/ts-node ../scripts/update-lambda-code.ts`;
    new command.local.Command(`${lambdaName}-code`, {
        create: codeCmd,
        update: codeCmd,
        environment: {
            BUILD_OUTPUT_HASH:         sourceHash,
            APT_AWSCLI_V2_LAMBDA_NAME: lambdaName,
        },
        triggers: [sourceHash, cfg.lambdaArch],
    }, { dependsOn: [lambdaFn] });

    return { lambdaFn, logGroup };
}
