import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { AppConfig, resolvePublicBaseUrl } from "./config";
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
    // checkAndBuild() ensures the bootstrap binary exists before Pulumi evaluates the AssetArchive.
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

    // Cloudflare integration: only the SSM parameter name and non-secret
    // identifiers are passed to the Lambda. The API token itself stays in
    // SSM SecureString and is never written to Pulumi state.
    if (cfg.cloudflareEnabled) {
        const publicBaseUrl = resolvePublicBaseUrl(cfg);
        if (!cfg.cloudflareSsmParam || !cfg.cloudflareZoneId || !publicBaseUrl) {
            // Should be impossible after loadConfig validation; guard anyway.
            throw new Error("cloudflareEnabled=true but required fields are missing");
        }
        lambdaEnvVars.APT_AWSCLI_V2_CF_SSM_PARAM       = cfg.cloudflareSsmParam;
        lambdaEnvVars.APT_AWSCLI_V2_CF_ZONE_ID         = cfg.cloudflareZoneId;
        lambdaEnvVars.APT_AWSCLI_V2_CF_PUBLIC_BASE_URL = publicBaseUrl;
    }

    // ─── Lambda Function ──────────────────────────────────────────────────────
    // sourceHash includes lambdaArch, so changing architecture also changes the binary path.
    //
    // We use AssetArchive (content-hashed) over FileArchive (zip-bytes-hashed) so
    // that identical source produces an identical Pulumi asset hash on different
    // machines — the zip Pulumi packs internally embeds timestamps, but the input
    // bootstrap binary is reproducible. This avoids spurious code re-uploads when
    // a different operator runs `pulumi up` on the same commit, while still
    // re-uploading whenever the bootstrap binary actually changes.
    const bootstrapPath = path.join("..", "pulumi.out", ".cache", `${sourceHash}.bootstrap`);

    const lambdaFn = new aws.lambda.Function(lambdaName, {
        name: lambdaName,
        runtime: "provided.al2023",
        architectures: [cfg.lambdaArch],
        code: new pulumi.asset.AssetArchive({
            bootstrap: new pulumi.asset.FileAsset(bootstrapPath),
        }),
        sourceCodeHash: sourceHash,
        handler: "bootstrap",
        role: lambdaRole.arn,
        memorySize: cfg.lambdaMemorySize,
        timeout: cfg.lambdaTimeout,
        ephemeralStorage: { size: cfg.lambdaEphemeralStorage },
        environment: { variables: lambdaEnvVars },
    }, {
        dependsOn: [lambdaRole, lambdaRolePolicy, logGroup],
    });

    return { lambdaFn, logGroup };
}
