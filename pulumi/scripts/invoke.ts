/**
 * invoke.ts
 *
 * Usage: npm run invoke '<json_payload>'
 *
 * Invokes the Lambda function and outputs the response to stdout.
 * If FunctionError is present, outputs to stderr and exits with code 1.
 */

import {
    LambdaClient,
    InvokeCommand,
} from "@aws-sdk/client-lambda";
import { getLambdaName, handleError, addErrorContext } from "./preflight";

const payload = process.argv[2] ?? "{}";

(async () => {
    const funcName = getLambdaName();
    const client   = new LambdaClient({});
    addErrorContext(client);
    const resp = await client.send(new InvokeCommand({
        FunctionName:   funcName,
        Payload:        Buffer.from(payload, "utf8"),
        LogType:        "Tail",
    }));

    if (resp.LogResult) {
        process.stderr.write(Buffer.from(resp.LogResult, "base64").toString("utf8"));
    }

    const body = resp.Payload ? Buffer.from(resp.Payload).toString("utf8") : "";

    if (resp.FunctionError) {
        process.stderr.write(`FunctionError: ${resp.FunctionError}\n`);
        process.stderr.write(`${body}\n`);
        process.exit(1);
    }

    process.stdout.write(body + "\n");
})().catch(handleError);
