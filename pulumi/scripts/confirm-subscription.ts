/**
 * confirm-subscription.ts
 *
 * Confirms an SNS subscription via SDK to enable AuthenticateOnUnsubscribe.
 * When AuthenticateOnUnsubscribe is enabled, unsubscription via email link is disabled.
 * (AWS authentication is required to unsubscribe)
 *
 * Usage:
 *   npm run confirm-subscription -- '<SNS confirmation URL or Token>'
 *
 * Example URL format:
 *   https://sns.<region>.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:...&Token=<token>
 */

import { SNSClient, ConfirmSubscriptionCommand } from "@aws-sdk/client-sns";
import { handleError } from "./preflight";

function parseArg(arg: string): { topicArn: string; token: string } {
    let url: URL;
    try {
        url = new URL(arg);
    } catch {
        throw new Error(`Invalid argument: expected a full SNS confirmation URL.\nGot: ${arg}`);
    }

    const topicArn = url.searchParams.get("TopicArn");
    const token    = url.searchParams.get("Token");

    if (!topicArn) throw new Error("TopicArn not found in URL");
    if (!token)    throw new Error("Token not found in URL");

    return { topicArn, token };
}

async function main(): Promise<void> {
    const arg = process.argv[2];
    if (!arg) {
        console.error("Usage: npm run confirm-subscription -- '<SNS confirmation URL>'");
        process.exit(1);
    }

    const { topicArn, token } = parseArg(arg);

    // Extract region from TopicArn and create SNSClient
    // arn:aws:sns:<region>:<account>:<name>
    const region = topicArn.split(":")[3];
    if (!region) throw new Error(`Could not extract region from TopicArn: ${topicArn}`);

    const client = new SNSClient({ region });

    console.log(`TopicArn : ${topicArn}`);
    console.log(`Region   : ${region}`);
    console.log("Confirming subscription with AuthenticateOnUnsubscribe=true ...");

    const result = await client.send(new ConfirmSubscriptionCommand({
        TopicArn:                topicArn,
        Token:                   token,
        AuthenticateOnUnsubscribe: "true",
    }));

    console.log(`Subscription confirmed: ${result.SubscriptionArn}`);
    console.log("Unsubscription via email link is now disabled. AWS authentication is required to unsubscribe.");
}

main().catch(handleError);
