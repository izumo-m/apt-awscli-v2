/**
 * update-lambda-code.ts
 *
 * Called via ts-node from the lambdaCode Command (pulumi/src/lambda.ts).
 * Reads BUILD_OUTPUT_HASH and APT_AWSCLI_V2_LAMBDA_NAME from environment variables
 * and updates the Lambda function code using @aws-sdk/client-lambda.
 */

import * as path from "path";
import * as fs from "fs";
import { handleError, addErrorContext } from "./preflight";
import {
    LambdaClient,
    UpdateFunctionCodeCommand,
} from "@aws-sdk/client-lambda";
import { waitUntilFunctionUpdated } from "@aws-sdk/client-lambda";

const hash     = process.env.BUILD_OUTPUT_HASH;
const funcName = process.env.APT_AWSCLI_V2_LAMBDA_NAME;

if (!hash)     { console.error("BUILD_OUTPUT_HASH is not set");         process.exit(1); }
if (!funcName) { console.error("APT_AWSCLI_V2_LAMBDA_NAME is not set"); process.exit(1); }

// __dirname = pulumi/scripts/
// ZIP is at pulumi/pulumi.out/.cache/{hash}.zip
const zipPath = path.join(__dirname, "..", "pulumi.out", ".cache", `${hash}.zip`);

if (!fs.existsSync(zipPath)) {
    console.error(`ZIP not found: ${zipPath}`);
    process.exit(1);
}

const zipBytes = fs.readFileSync(zipPath);

const client = new LambdaClient({});
addErrorContext(client);

(async () => {
    console.log(`Updating Lambda function code: ${funcName}`);
    await client.send(new UpdateFunctionCodeCommand({
        FunctionName: funcName,
        ZipFile: zipBytes,
    }));

    console.log("Waiting for function update to complete...");
    await waitUntilFunctionUpdated(
        { client, maxWaitTime: 300 },
        { FunctionName: funcName },
    );

    console.log("Lambda function code updated successfully.");
})().catch(handleError);
