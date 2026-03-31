import * as path from "path";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { loadConfig }                                   from "./config";
import { GpgKeyInit }                                   from "./gpg";
import { createStorage, parseS3Uri }                    from "./storage";
import { createLambdaIam }                              from "./iam";
import { createLambda }                                 from "./lambda";
import { createNotification }                           from "./notification";
import { createScheduler }                              from "./scheduler";

// ─── Config ───────────────────────────────────────────────────────────────────

const cfg           = loadConfig();
const currentRegion = aws.getRegionOutput().name;

// ─── Resource Creation ──────────────────────────────────────────────────────────────

new GpgKeyInit(`${cfg.resourcePrefix}-gpg-key-init`, {
    region:         currentRegion,
    ssmParamName:   cfg.ssmParamName,
    maintainerName: cfg.maintainerName,
    email:          cfg.email,
});

const { bucket, logsBucket }           = createStorage(cfg);

// ─── index.html (generated from README.md by preview.ts / up.ts) ────────────
const { prefix: s3Prefix } = parseS3Uri(cfg.s3Uri);
const indexHtmlPath = path.resolve(__dirname, "..", "pulumi.out", "index.html");

new aws.s3.BucketObjectv2(`${cfg.resourcePrefix}-index-html`, {
    bucket: bucket.id,
    key: `${s3Prefix}index.html`,
    source: new pulumi.asset.FileAsset(indexHtmlPath),
    contentType: "text/html; charset=utf-8",
    cacheControl: "public, max-age=86400",
});

const { lambdaRole, lambdaRolePolicy } = createLambdaIam(cfg);
const { lambdaFn, logGroup }           = createLambda(cfg, lambdaRole, lambdaRolePolicy);
if (cfg.enableScheduler) {
    createScheduler(cfg, lambdaFn);
}
const notification = cfg.notificationEmail
    ? createNotification(cfg, cfg.notificationEmail, lambdaFn)
    : undefined;

// ─── Outputs ──────────────────────────────────────────────────────────────────

export const bucketNameOutput      = bucket.id;
export const accessLogsBucketName  = logsBucket?.id;
export const lambdaFunctionName    = lambdaFn.name;
export const lambdaFunctionArn     = lambdaFn.arn;
export const lambdaRoleArn         = lambdaRole.arn;
export const logGroupNameOutput    = logGroup.name;
