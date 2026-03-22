import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { AppConfig } from "./config";

// ─── Notification ─────────────────────────────────────────────────────────────
// Called only when notificationEmail is configured.
// Creates SNS Topic + Email Subscription + CloudWatch Alarm (Lambda Errors).

export function createNotification(
    cfg: AppConfig,
    notificationEmail: string,
    lambdaFn: aws.lambda.Function,
): { topicArn: pulumi.Output<string> } {
    const prefix = cfg.resourcePrefix;

    const topic = new aws.sns.Topic(`${prefix}-notification`, {
        name: `${prefix}-notification`,
    });

    new aws.sns.TopicSubscription(`${prefix}-notification-email`, {
        topic: topic.arn,
        protocol: "email",
        endpoint: notificationEmail,
    });

    // Monitor Lambda Errors metric. Covers crashes, timeouts, and unhandled exceptions.
    new aws.cloudwatch.MetricAlarm(`${prefix}-lambda-errors`, {
        name:             `${prefix}-lambda-errors`,
        alarmDescription: "Lambda function returned an error (crash, timeout, or exception)",
        namespace:        "AWS/Lambda",
        metricName:       "Errors",
        dimensions: {
            FunctionName: lambdaFn.name,
        },
        statistic:          "Sum",
        period:             60,
        evaluationPeriods:  1,
        threshold:          1,
        comparisonOperator: "GreaterThanOrEqualToThreshold",
        treatMissingData:   "notBreaching",
        alarmActions:       [topic.arn],
    });

    return { topicArn: topic.arn };
}
