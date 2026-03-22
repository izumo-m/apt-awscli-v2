import * as aws from "@pulumi/aws";
import { AppConfig } from "./config";
import { createSchedulerIam } from "./iam";

// ─── EventBridge Scheduler ────────────────────────────────────────────────────
// EventBridge Scheduler (new API) requires a dedicated IAM role to invoke Lambda directly.
// Unlike the old CloudWatch Events API (aws.cloudwatch.EventRule),
// a resource-based policy (aws.lambda.Permission) on the Lambda side is not needed.

export function createScheduler(
    cfg: AppConfig,
    lambdaFn: aws.lambda.Function,
): void {
    const scheduleName = `${cfg.resourcePrefix}-schedule`;

    const { schedulerRole } = createSchedulerIam({ prefix: cfg.resourcePrefix, lambdaArn: lambdaFn.arn });

    new aws.scheduler.Schedule(scheduleName, {
        name: scheduleName,
        scheduleExpression: cfg.scheduleCron,
        flexibleTimeWindow: { mode: "OFF" },
        target: {
            arn: lambdaFn.arn,
            roleArn: schedulerRole.arn,
            retryPolicy: {
                maximumRetryAttempts: 0,
            },
        },
    });
}
