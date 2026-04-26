import * as pulumi from "@pulumi/pulumi";

export type AptArch    = "amd64" | "arm64";
export type LambdaArch = "x86_64" | "arm64";

const VALID_APT_ARCHES:    AptArch[]    = ["amd64", "arm64"];
const VALID_LAMBDA_ARCHES: LambdaArch[] = ["x86_64", "arm64"];

function validateAptArches(values: string[]): AptArch[] {
    for (const v of values) {
        if (!VALID_APT_ARCHES.includes(v as AptArch)) {
            throw new Error(
                `Invalid aptArches value: "${v}". Must be one of: ${VALID_APT_ARCHES.join(", ")}`
            );
        }
    }
    return values as AptArch[];
}

function validateLambdaArch(value: string): LambdaArch {
    if (!VALID_LAMBDA_ARCHES.includes(value as LambdaArch)) {
        throw new Error(
            `Invalid lambdaArch value: "${value}". Must be one of: ${VALID_LAMBDA_ARCHES.join(", ")}`
        );
    }
    return value as LambdaArch;
}

export interface AppConfig {
    // Required
    resourcePrefix:         string;
    email:                  string;
    maintainerName:         string;
    // S3
    s3Uri:                  string;
    accessLogsS3Uri:        string | undefined;
    accessLogRetentionDays: number;
    // Optional (with defaults)
    ssmParamName:           string;
    maxVersions:            number;
    aptArches:              AptArch[];
    aptPackages:            string[];
    lambdaArch:             LambdaArch;
    lambdaMemorySize:       number;
    lambdaEphemeralStorage: number;
    lambdaTimeout:          number;
    lambdaThreads:          number;
    lambdaZstdThreads:      number;
    lambdaZstdLevel:        number;
    scheduleCron:           string;
    logRetentionDays:       number;
    enableScheduler:        boolean;
    notificationEmail:      string | undefined;
    // ─── Cloudflare integration (opt-in) ──────────────────────────────────
    // Master switch. When false (default), no Cloudflare resources are
    // created and Lambda skips cache invalidation.
    cloudflareEnabled:        boolean;
    // Required when cloudflareEnabled is true.
    cloudflareAccountId:      string | undefined;
    cloudflareZoneId:         string | undefined;
    // SSM SecureString parameter holding `{"api_token":"..."}` for Lambda
    // runtime cache purge. Optional; defaults to `/${resourcePrefix}/cloudflare`
    // when cloudflareEnabled is true.
    cloudflareSsmParam:       string | undefined;
    // Opt-in: when set, Pulumi creates a WorkersCustomDomain so the Worker
    // is reachable at https://<this-host>.
    cloudflareCustomDomain:   string | undefined;
    // Opt-in override for the public base URL Lambda uses to construct
    // purge URLs. If unset, derived as `https://${cloudflareCustomDomain}`.
    cloudflarePublicBaseUrl:  string | undefined;
}

export function loadConfig(): AppConfig {
    const config         = new pulumi.Config("aptAwscliV2");
    const resourcePrefix = config.get("resourcePrefix") ?? "apt-awscli-v2";

    return {
        resourcePrefix,
        email:                  config.require("email"),
        maintainerName:         config.require("maintainerName"),
        s3Uri:                  config.require("s3Uri"),
        accessLogsS3Uri:        config.get("accessLogsS3Uri"),
        accessLogRetentionDays: config.getNumber("accessLogRetentionDays") ?? -1,
        ssmParamName:           config.get("ssmParamName") ?? `/${resourcePrefix}/private.key`,
        maxVersions:            config.getNumber("maxVersions") ?? -1,
        aptArches:              validateAptArches(config.getObject<string[]>("aptArches") ?? ["amd64"]),
        aptPackages:            config.getObject<string[]>("aptPackages") ?? ["aws-cli", "session-manager-plugin"],
        lambdaArch:             validateLambdaArch(config.get("lambdaArch") ?? "arm64"),
        lambdaMemorySize:       config.getNumber("lambdaMemorySize")       ?? 5120,
        lambdaEphemeralStorage: config.getNumber("lambdaEphemeralStorage") ?? 512,
        lambdaTimeout:          config.getNumber("lambdaTimeout")           ?? 900,
        lambdaThreads:          config.getNumber("lambdaThreads")       ?? 8,
        lambdaZstdThreads:      config.getNumber("lambdaZstdThreads")   ?? 4,
        lambdaZstdLevel:        config.getNumber("lambdaZstdLevel")     ?? 9,
        scheduleCron:           config.get("scheduleCron")           ?? "cron(0 0 ? * TUE-SAT *)",
        logRetentionDays:       config.getNumber("logRetentionDays") ?? 14,
        enableScheduler:        config.getBoolean("enableScheduler") ?? true,
        notificationEmail:      config.get("notificationEmail"),
        ...loadCloudflareConfig(config, resourcePrefix),
    };
}

interface CloudflareConfig {
    cloudflareEnabled:        boolean;
    cloudflareAccountId:      string | undefined;
    cloudflareZoneId:         string | undefined;
    cloudflareSsmParam:       string | undefined;
    cloudflareCustomDomain:   string | undefined;
    cloudflarePublicBaseUrl:  string | undefined;
}

function loadCloudflareConfig(config: pulumi.Config, resourcePrefix: string): CloudflareConfig {
    const enabled         = config.getBoolean("cloudflareEnabled") ?? false;
    const accountId       = config.get("cloudflareAccountId");
    const zoneId          = config.get("cloudflareZoneId");
    const ssmParam        = config.get("cloudflareSsmParam");
    const customDomain    = config.get("cloudflareCustomDomain");
    const publicBaseUrl   = config.get("cloudflarePublicBaseUrl");

    if (!enabled) {
        // Cloudflare disabled: warn if any Cloudflare-specific keys are set.
        const stray = [
            accountId      ? "cloudflareAccountId"     : "",
            zoneId         ? "cloudflareZoneId"        : "",
            ssmParam       ? "cloudflareSsmParam"      : "",
            customDomain   ? "cloudflareCustomDomain"  : "",
            publicBaseUrl  ? "cloudflarePublicBaseUrl" : "",
        ].filter(s => s.length > 0);
        if (stray.length > 0) {
            pulumi.log.warn(
                `Cloudflare config keys are set but cloudflareEnabled is false; ignoring: ${stray.join(", ")}`,
            );
        }
        return {
            cloudflareEnabled:       false,
            cloudflareAccountId:     undefined,
            cloudflareZoneId:        undefined,
            cloudflareSsmParam:      undefined,
            cloudflareCustomDomain:  undefined,
            cloudflarePublicBaseUrl: undefined,
        };
    }

    // Cloudflare enabled: enforce required fields.
    if (!accountId) throw new Error("cloudflareEnabled=true requires aptAwscliV2:cloudflareAccountId");
    if (!zoneId)    throw new Error("cloudflareEnabled=true requires aptAwscliV2:cloudflareZoneId");

    // Lambda needs a public base URL to construct purge URLs.
    // Provide either an explicit publicBaseUrl, or a customDomain to derive from.
    if (!publicBaseUrl && !customDomain) {
        throw new Error(
            "cloudflareEnabled=true requires either aptAwscliV2:cloudflareCustomDomain " +
            "or aptAwscliV2:cloudflarePublicBaseUrl so the Lambda knows which URLs to purge",
        );
    }

    return {
        cloudflareEnabled:       true,
        cloudflareAccountId:     accountId,
        cloudflareZoneId:        zoneId,
        cloudflareSsmParam:      ssmParam ?? `/${resourcePrefix}/cloudflare`,
        cloudflareCustomDomain:  customDomain,
        cloudflarePublicBaseUrl: publicBaseUrl,
    };
}

/** Resolve the public base URL Lambda will use to build purge URLs. */
export function resolvePublicBaseUrl(cfg: AppConfig): string | undefined {
    if (!cfg.cloudflareEnabled) return undefined;
    if (cfg.cloudflarePublicBaseUrl) return cfg.cloudflarePublicBaseUrl.replace(/\/+$/, "");
    if (cfg.cloudflareCustomDomain)  return `https://${cfg.cloudflareCustomDomain}`;
    return undefined;
}
