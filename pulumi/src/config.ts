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
    };
}
