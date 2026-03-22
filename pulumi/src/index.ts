import * as aws from "@pulumi/aws";
import { loadConfig }                                   from "./config";
import { GpgKeyInit }                                   from "./gpg";
import { createStorage }                                from "./storage";
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
