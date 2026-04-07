import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { AppConfig } from "./config";
import { watchedFiles, computeSourceHash } from "./lambdaSource";
import { checkAndBuild } from "./check-and-build";

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
    //
    // Hash computation uses relative paths from lambdaDir as baseDir (via path.relative in computeSourceHash).
    // This ensures hash values are consistent across user environments.
    // lambdaDir itself is an absolute path based on __dirname, so it doesn't depend on the working directory.
    //
    // checkAndBuild() ensures the archive exists before Pulumi evaluates the FileArchive.
    // It returns the final hash (which may differ if the build updated watched files like Cargo.lock).
    const lambdaDir = path.resolve(__dirname, "../../lambda");

    const watchedFileList = watchedFiles(lambdaDir);
    const sourceHash      = checkAndBuild(
        computeSourceHash(watchedFileList, lambdaDir, [cfg.lambdaArch]),
        cfg.lambdaArch,
    );


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
    // sourceHash includes lambdaArch, so changing architecture also changes the archive path.
    // ignoreChanges on "code" prevents diffs from zip metadata (timestamps);
    // sourceCodeHash drives update detection based on the source hash alone.
    const archivePath = path.join("..", "pulumi.out", ".cache", `${sourceHash}.zip`);

    const lambdaFn = new aws.lambda.Function(lambdaName, {
        name: lambdaName,
        runtime: "provided.al2023",
        architectures: [cfg.lambdaArch],
        code: new pulumi.asset.FileArchive(archivePath),
        sourceCodeHash: sourceHash,
        handler: "bootstrap",
        role: lambdaRole.arn,
        memorySize: cfg.lambdaMemorySize,
        timeout: cfg.lambdaTimeout,
        ephemeralStorage: { size: cfg.lambdaEphemeralStorage },
        environment: { variables: lambdaEnvVars },
    }, {
        dependsOn: [lambdaRole, lambdaRolePolicy, logGroup],
        ignoreChanges: ["code"],
    });

    return { lambdaFn, logGroup };
}
