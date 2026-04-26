/**
 * cf-config.ts
 *
 * Manage the Cloudflare API token stored in an SSM SecureString parameter
 * for the Lambda's runtime cache purge. The parameter name comes from
 * Pulumi config (`aptAwscliV2:cloudflareSsmParam`).
 *
 * Subcommands:
 *   set    Upload a JSON file or token value to SSM (overwrites)
 *   show   Read back the JSON from SSM (token redacted)
 *
 * Usage:
 *   npm run cf-config:set  -- --input cloudflare.json
 *   npm run cf-config:set  -- --token "<token>"
 *   npm run cf-config:show
 *
 * Expected JSON shape:
 *   { "api_token": "<cloudflare api token with Cache Purge permission>" }
 *
 * Required token permissions:
 *   - Zone → Cache Purge   (scoped to the target zone only)
 *
 * NOTE: This is the LAMBDA token. The OPERATOR token used by `pulumi up`
 * (CLOUDFLARE_API_TOKEN) is separate; see pulumi/README.md for details.
 */

import * as fs from "fs";
import {
    SSMClient,
    PutParameterCommand,
    GetParameterCommand,
} from "@aws-sdk/client-ssm";
import { addErrorContext, getCloudflareSsmParamName, handleError } from "./preflight";

interface LambdaTokenJson {
    api_token: string;
}

interface ParsedArgs {
    subcommand: "set" | "show";
    input?:     string;
    token?:     string;
}

function parseArgs(argv: string[]): ParsedArgs {
    const subcommand = argv[2];
    if (subcommand !== "set" && subcommand !== "show") {
        usage();
        process.exit(1);
    }
    const args: ParsedArgs = { subcommand };
    for (let i = 3; i < argv.length; i++) {
        if (argv[i] === "--input")      args.input = argv[++i];
        else if (argv[i] === "--token") args.token = argv[++i];
        else {
            process.stderr.write(`Unknown argument: ${argv[i]}\n`);
            usage();
            process.exit(1);
        }
    }
    return args;
}

function usage(): void {
    process.stderr.write(
        "Usage:\n" +
        "  npm run cf-config:set  -- --input <path-to-json>\n" +
        "  npm run cf-config:set  -- --token \"<api-token>\"\n" +
        "  npm run cf-config:show\n"
    );
}

function validateToken(obj: unknown): LambdaTokenJson {
    if (typeof obj !== "object" || obj === null) {
        throw new Error("Input JSON must be an object");
    }
    const t = (obj as Record<string, unknown>).api_token;
    if (typeof t !== "string" || t.length === 0) {
        throw new Error("Missing or empty required field: api_token");
    }
    return { api_token: t };
}

function redactToken(token: string): string {
    if (token.length <= 8) return "***";
    return `${token.slice(0, 4)}...${token.slice(-4)} (len=${token.length})`;
}

async function setToken(paramName: string, args: ParsedArgs): Promise<void> {
    let token: string;
    if (args.token) {
        token = args.token;
    } else if (args.input) {
        if (!fs.existsSync(args.input)) {
            throw new Error(`Input file not found: ${args.input}`);
        }
        const raw    = fs.readFileSync(args.input, "utf8");
        const parsed = validateToken(JSON.parse(raw));
        token = parsed.api_token;
    } else {
        throw new Error("Either --input <path-to-json> or --token <value> is required for `set`");
    }
    if (token.length === 0) {
        throw new Error("api_token is empty");
    }

    const canonical = JSON.stringify({ api_token: token });

    const ssm = new SSMClient({});
    addErrorContext(ssm);

    await ssm.send(new PutParameterCommand({
        Name:      paramName,
        Value:     canonical,
        Type:      "SecureString",
        Overwrite: true,
    }));

    console.log(`Cloudflare API token uploaded to SSM:`);
    console.log(`  parameter:  ${paramName}`);
    console.log(`  api_token:  ${redactToken(token)}`);
}

async function showToken(paramName: string): Promise<void> {
    const ssm = new SSMClient({});
    addErrorContext(ssm);

    const resp = await ssm.send(new GetParameterCommand({
        Name:           paramName,
        WithDecryption: true,
    }));
    const value = resp.Parameter?.Value;
    if (!value) {
        process.stderr.write(`SSM parameter ${paramName} has no value.\n`);
        process.exit(1);
    }
    const parsed = validateToken(JSON.parse(value));

    console.log(`Cloudflare API token in SSM:`);
    console.log(`  parameter:  ${paramName}`);
    console.log(`  api_token:  ${redactToken(parsed.api_token)}`);
}

async function main(): Promise<void> {
    const args      = parseArgs(process.argv);
    const paramName = getCloudflareSsmParamName();

    if (args.subcommand === "set") {
        await setToken(paramName, args);
    } else {
        await showToken(paramName);
    }
}

main().catch(handleError);
