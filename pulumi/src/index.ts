import * as fs from "fs";
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
import { createCloudflareWorker }                       from "./cloudflare";
import { generateIndexHtml }                            from "./indexHtml";

// ─── Config ───────────────────────────────────────────────────────────────────

const cfg           = loadConfig();
const currentRegion = aws.getRegionOutput().name;

// ─── Stack Config Backup ─────────────────────────────────────────────────────
//
// When the Pulumi backend is S3 (the supported deployment path for this
// project), back up Pulumi.{stack}.yaml to that bucket as a managed asset
// so that (a) edits appear as a normal diff in `pulumi preview` and (b) the
// file can be restored on another machine via `npm run restore-config <stack>`.
// For non-S3 backends (e.g. Pulumi Cloud) this block is skipped entirely.

const backendUrl   = process.env["PULUMI_BACKEND_URL"] ?? "";
const backendMatch = backendUrl.match(/^s3:\/\/([^/]+)/);
if (backendMatch) {
    const stateBucket = backendMatch[1];
    const stackName   = pulumi.getStack();
    const configPath  = path.resolve(__dirname, "..", `Pulumi.${stackName}.yaml`);
    if (fs.existsSync(configPath)) {
        new aws.s3.BucketObjectv2("stack-config-backup", {
            bucket:      stateBucket,
            key:         `stack-configs/Pulumi.${stackName}.yaml`,
            source:      new pulumi.asset.FileAsset(configPath),
            contentType: "text/yaml; charset=utf-8",
        });
    }
}

// ─── Resource Creation ──────────────────────────────────────────────────────────────

new GpgKeyInit(`${cfg.resourcePrefix}-gpg-key-init`, {
    region:         currentRegion,
    ssmParamName:   cfg.ssmParamName,
    maintainerName: cfg.maintainerName,
    email:          cfg.email,
});

const { bucket, logsBucket }           = createStorage(cfg);

// ─── index.html (generated from README.md) ─────────────────────────────────
generateIndexHtml();

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
if (cfg.notificationEmail) {
    createNotification(cfg, cfg.notificationEmail, lambdaFn);
}

// ─── Cloudflare Worker (opt-in) ────────────────────────────────────────────
// Requires CLOUDFLARE_API_TOKEN env var when cloudflareEnabled is true.
// See pulumi/src/cloudflare.ts for required token permissions.
if (cfg.cloudflareEnabled) {
    createCloudflareWorker(cfg);
}

// ─── Outputs ──────────────────────────────────────────────────────────────────

export const bucketNameOutput      = bucket.id;
export const accessLogsBucketName  = logsBucket?.id;
export const lambdaFunctionName    = lambdaFn.name;
export const lambdaFunctionArn     = lambdaFn.arn;
export const lambdaRoleArn         = lambdaRole.arn;
export const logGroupNameOutput    = logGroup.name;
