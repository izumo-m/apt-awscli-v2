/**
 * pre-flight: Module responsible for Lambda builds and source diff display.
 *
 * ## Build guarantee
 * Pulumi evaluates FileArchive hashes during the plan phase, so the archive
 * must exist before any pulumi command.  checkAndBuild() (src/check-and-build.ts)
 * is called from up.ts / preview.ts to ensure this.
 *
 * ## Archive cache
 * Built archives are placed at pulumi.out/.cache/{hash}.zip (PulumiAsset).
 * The hash takes both source files and lambdaArch as inputs, so changing
 * the architecture also changes the hash (= path).
 * If the archive already exists, the rebuild is skipped.
 *
 * ## Source snapshots
 * Snapshots are saved to pulumi.out/assets.{hash}/ (PulumiAsset).
 * createCurrentSnapshot(lambdaArch) is called after a successful pulumi up for use in the next preview --diff.
 * Snapshots are not created during preview.
 *
 * ## Source diff display
 * showSourceDiff(deployedHash, lambdaArch) compares assets.{deployedHash}/ with the current source
 * and displays a unified diff. deployedHash is the deployed hash obtained via the Automation API.
 * If assets.{deployedHash}/ does not exist, no diff is shown (becomes available after npm run up).
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { Deployment } from "@pulumi/pulumi/automation";
import { collectFiles, watchedFiles, computeSourceHash } from "../src/lambdaSource";
import { PulumiAsset } from "../src/pulumiAsset";

export const SCRIPTS_DIR    = path.resolve(__dirname);
export const PULUMI_DIR     = path.resolve(SCRIPTS_DIR, "..");
export const LAMBDA_DIR     = path.resolve(PULUMI_DIR, "..", "lambda");
export const PULUMI_OUT_DIR = path.join(PULUMI_DIR, "pulumi.out");

// ─── PulumiAsset Factory ─────────────────────────────────────────────────────

/**
 * Create a Lambda asset.
 * The hash includes lambdaArch, so changing the architecture also changes the hash.
 */
export function createLambdaAsset(lambdaDir: string, lambdaArch: string): PulumiAsset {
    const files = watchedFiles(lambdaDir);
    const hash  = computeSourceHash(files, lambdaDir, [lambdaArch]);
    return new PulumiAsset(hash, files, lambdaDir);
}

// ─── Source Snapshots ────────────────────────────────────────────────────────

/** Save the current source as a snapshot after a successful pulumi up (for the next preview --diff). */
export function createCurrentSnapshot(lambdaArch: string): void {
    createLambdaAsset(LAMBDA_DIR, lambdaArch).createSnapshot(PULUMI_OUT_DIR);
}

// ─── Source Diff Display ─────────────────────────────────────────────────────

const DIFF_CONTEXT = 3;

type DiffOp = { t: "eq" | "del" | "ins"; v: string };

/** Compute the LCS table (for unified diff). */
function lcsTable(a: string[], b: string[]): number[][] {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0) as number[]);
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
    return dp;
}

/** Generate a sequence of diff operations from the LCS. */
function diffOps(oldL: string[], newL: string[]): DiffOp[] {
    const dp = lcsTable(oldL, newL);
    const ops: DiffOp[] = [];
    let i = oldL.length, j = newL.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldL[i-1] === newL[j-1]) {
            ops.unshift({ t: "eq",  v: oldL[i-1] }); i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
            ops.unshift({ t: "ins", v: newL[j-1] }); j--;
        } else {
            ops.unshift({ t: "del", v: oldL[i-1] }); i--;
        }
    }
    return ops;
}

/** Write a single file's diff to stdout in unified diff format. Does nothing if there is no diff. */
function printFileDiff(oldPath: string | null, newPath: string | null, relPath: string): void {
    const oldText = oldPath ? fs.readFileSync(oldPath, "utf8") : "";
    const newText = newPath ? fs.readFileSync(newPath, "utf8") : "";
    if (oldText === newText) return;

    const oldL = oldText.split("\n");
    const newL = newText.split("\n");
    const ops  = diffOps(oldL, newL);
    if (!ops.some(o => o.t !== "eq")) return;

    // Collect changed line indices and determine ranges including DIFF_CONTEXT lines before/after
    const inCtx = new Set<number>();
    ops.forEach((o, i) => {
        if (o.t !== "eq")
            for (let k = Math.max(0, i - DIFF_CONTEXT); k <= Math.min(ops.length - 1, i + DIFF_CONTEXT); k++)
                inCtx.add(k);
    });

    process.stdout.write(`--- a/${relPath}\n`);
    process.stdout.write(`+++ b/${relPath}\n`);

    let hunk: string[] = [];
    let oldStart = 0, newStart = 0, oldCount = 0, newCount = 0;
    let oldLine  = 1, newLine  = 1;
    let inHunk   = false;

    const flushHunk = () => {
        if (!inHunk) return;
        process.stdout.write(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`);
        hunk.forEach(l => process.stdout.write(l + "\n"));
        inHunk = false;
    };

    for (let idx = 0; idx <= ops.length; idx++) {
        if (idx === ops.length || !inCtx.has(idx)) {
            flushHunk();
            if (idx < ops.length) {
                if (ops[idx].t !== "ins") oldLine++;
                if (ops[idx].t !== "del") newLine++;
            }
            continue;
        }
        const op = ops[idx];
        if (!inHunk) {
            inHunk = true; hunk = [];
            oldStart = oldLine; newStart = newLine;
            oldCount = 0;      newCount = 0;
        }
        if (op.t === "eq")  { hunk.push(` ${op.v}`); oldLine++; newLine++; oldCount++; newCount++; }
        if (op.t === "del") { hunk.push(`-${op.v}`); oldLine++;            oldCount++;             }
        if (op.t === "ins") { hunk.push(`+${op.v}`); newLine++;            newCount++;             }
    }
}

/**
 * Display source diff against the deployed code.
 * Pass the hash obtained via Automation API (exportStack) as deployedHash.
 * lambdaArch is the current architecture obtained from pulumi config get.
 *
 * - Snapshot exists: show unified diff between assets.{deployedHash}/ and current source
 * - Snapshot missing: show message only (resolved by running npm run up once)
 * - No diff: do nothing
 */
export function showSourceDiff(deployedHash: string, lambdaArch: string): void {
    const asset       = createLambdaAsset(LAMBDA_DIR, lambdaArch);
    const currentHash = asset.hash;

    if (currentHash === deployedHash) return;  // Same as deployed

    const oldDir = path.join(PULUMI_OUT_DIR, `assets.${deployedHash}`);
    if (!fs.existsSync(oldDir)) {
        console.log(`Lambda source changed (deployed snapshot ${deployedHash.slice(0, 12)} not found; run npm run up once to capture baseline)`);
        return;
    }

    // Compare assets.{deployedHash}/ with current source files
    const oldRelPaths = new Set(collectFiles(oldDir).map(f => path.relative(oldDir, f)));
    const newFilesMap = asset.sourceFileMap();
    const allRel      = [...new Set([...oldRelPaths, ...newFilesMap.keys()])].sort();

    console.log("── Lambda source diff ─────────────────────────────────────────");
    for (const rel of allRel) {
        const oldPath = oldRelPaths.has(rel) ? path.join(oldDir, rel) : null;
        const newPath = newFilesMap.get(rel) ?? null;
        printFileDiff(oldPath, newPath, rel);
    }
    console.log("───────────────────────────────────────────────────────────────");
}

// ─── Deployed Hash Retrieval ─────────────────────────────────────────────────

/**
 * Extract the deployed source hash from the Automation API exportStack() result.
 * Reads the Lambda Function's code.path (FileArchive) which contains the hash in the filename.
 * Falls back to the legacy Command-based format for backward compatibility during migration.
 */
export function extractDeployedHash(deployment: Deployment): string {
    type Resource = {
        type?: string;
        inputs?: {
            code?: { path?: string };
            environment?: { BUILD_OUTPUT_HASH?: string; BUILD_OUTPUT_ZIP?: string; BUILD_EXPECTED_HASH?: string };
        };
    };
    for (const r of (deployment.deployment?.resources ?? []) as Resource[]) {
        // Current: extract hash from Lambda code FileArchive path (.cache/{hash}.zip)
        if (r.type === "aws:lambda/function:Function") {
            const codePath = r.inputs?.code?.path;
            if (codePath) {
                const match = codePath.match(/([0-9a-f]{64})\.zip$/);
                if (match) return match[1];
            }
        }
    }
    // Legacy: extract from Command resource environment
    for (const r of (deployment.deployment?.resources ?? []) as Resource[]) {
        if (r.type === "command:local:Command") {
            const env = r.inputs?.environment;
            if (!env) continue;
            if (env.BUILD_OUTPUT_HASH) return env.BUILD_OUTPUT_HASH;
            if (env.BUILD_OUTPUT_ZIP) {
                const basename = env.BUILD_OUTPUT_ZIP.replace(/\.zip$/, "").split(/[\\/]/).pop();
                if (basename) return basename;
            }
            if (env.BUILD_EXPECTED_HASH) return env.BUILD_EXPECTED_HASH;
        }
    }
    return "";
}

// ─── Build ──────────────────────────────────────────────────────────────────

/** Read aptAwscliV2:lambdaArch from config and return it. Defaults to "arm64" if not set. */
export function getLambdaArch(): string {
    return getConfig("aptAwscliV2:lambdaArch") ?? "arm64";
}

// ─── Backend / Environment Variables ─────────────────────────────────────────

export interface BackendS3 {
    bucket: string;
    prefix: string;  // Prefix (with trailing slash, or "" if empty)
    url:    string;  // Original value of APT_AWSCLI_V2_BACKEND
}

/**
 * Parse the APT_AWSCLI_V2_BACKEND environment variable and return a BackendS3.
 * Returns null if not set.
 */
export function getBackendS3(): BackendS3 | null {
    const raw = process.env["APT_AWSCLI_V2_BACKEND"];
    if (!raw) return null;
    const match = raw.match(/^s3:\/\/([^/]+)(\/.*)?$/);
    if (!match) throw new Error(`Invalid APT_AWSCLI_V2_BACKEND: "${raw}" (expected s3://bucket[/prefix])`);
    const bucket    = match[1];
    const prefixRaw = match[2] ?? "";
    const prefix    = prefixRaw ? prefixRaw.replace(/^\//, "").replace(/\/?$/, "/") : "";
    return { bucket, prefix, url: raw };
}

/**
 * Return environment variables for child processes.
 * Exits with an error if APT_AWSCLI_V2_BACKEND is not set.
 */
export function getPulumiEnv(): NodeJS.ProcessEnv {
    const backend = getBackendS3();
    if (!backend) {
        process.stderr.write("Error: APT_AWSCLI_V2_BACKEND is not set.\n");
        process.stderr.write("  e.g.: export APT_AWSCLI_V2_BACKEND=s3://my-pulumi-state\n");
        process.exit(1);
    }
    return { ...process.env, PULUMI_BACKEND_URL: backend.url };
}

// ─── Stack Name ─────────────────────────────────────────────────────────────

/**
 * Return the stack name from the APT_AWSCLI_V2_STACK environment variable.
 * Exits with an error if not set.
 */
export function getCurrentStackName(): string {
    const envStack = process.env["APT_AWSCLI_V2_STACK"];
    if (!envStack) {
        process.stderr.write("Error: APT_AWSCLI_V2_STACK is not set.\n");
        process.stderr.write("  e.g.: export APT_AWSCLI_V2_STACK=dev\n");
        process.exit(1);
    }
    return envStack;
}

// ─── Stack Config File Verification ─────────────────────────────────────────

/**
 * Verify that Pulumi.{stack}.yaml exists locally.
 * Exits with an error message if not found.
 * Run "npm run bootstrap" to restore.
 */
export function ensureStackConfig(stackName: string): void {
    const configFileName = `Pulumi.${stackName}.yaml`;
    if (fs.existsSync(path.join(PULUMI_DIR, configFileName))) return;

    process.stderr.write(`Error: ${configFileName} not found.\n`);
    process.stderr.write(`Run "npm run bootstrap" to restore from Pulumi stack state.\n`);
    process.exit(1);
}

// ─── Save Config File to Stack Tags ─────────────────────────────────────────

/**
 * Save the contents of Pulumi.{stack}.yaml to the Pulumi state stack tag (stack-config).
 * Called after a successful pulumi up. Failures only produce warnings (do not undo the up).
 */
export function saveStackConfigToTag(stackName: string, pulumiEnv: NodeJS.ProcessEnv): void {
    const configPath = path.join(PULUMI_DIR, `Pulumi.${stackName}.yaml`);
    if (!fs.existsSync(configPath)) {
        process.stderr.write(`Warning: Pulumi.${stackName}.yaml not found, skipping stack tag update.\n`);
        return;
    }

    const encoded = Buffer.from(fs.readFileSync(configPath, "utf8")).toString("base64");
    const result  = spawnSync(
        "pulumi", ["stack", "tag", "set", "stack-config", encoded, "--stack", stackName],
        { cwd: PULUMI_DIR, env: pulumiEnv, stdio: ["pipe", "pipe", "inherit"], encoding: "utf8" },
    );

    if (result.status !== 0) {
        process.stderr.write(
            `Warning: failed to save stack config to Pulumi state tag.\n` +
            `  To retry: pulumi stack tag set stack-config "$(base64 -w0 Pulumi.${stackName}.yaml)"\n`
        );
    } else {
        console.log(`Stack config saved to Pulumi state (stack: ${stackName}).`);
    }
}

// ─── Config ─────────────────────────────────────────────────────────────────

/** Get a config value from Pulumi.<stack>.yaml. Returns defaultValue if not set. */
export function getConfig(key: string, defaultValue?: string): string | undefined {
    const stackName = getCurrentStackName();
    const yamlPath  = path.join(PULUMI_DIR, `Pulumi.${stackName}.yaml`);
    if (!fs.existsSync(yamlPath)) {
        throw new Error(
            `Stack config file not found: Pulumi.${stackName}.yaml\n` +
            `See Pulumi.sample.yaml for reference.`
        );
    }
    const content = yaml.load(fs.readFileSync(yamlPath, "utf8")) as
        { config?: Record<string, unknown> };
    const val = content?.config?.[key];
    if (val === undefined || val === null) return defaultValue;
    return String(val);
}

/** Return the Lambda function name from Pulumi config (`{resourcePrefix}-lambda`). */
export function getLambdaName(): string {
    const prefix = getConfig("aptAwscliV2:resourcePrefix");
    if (!prefix) throw new Error("aptAwscliV2:resourcePrefix is not configured");
    return `${prefix}-lambda`;
}

/**
 * Add middleware to an AWS SDK client that prefixes error messages with
 * "AWS:<Service>:<Operation>: " on failure.
 * Example: addErrorContext(client)  →  "AWS:Lambda:Invoke: The security token ..."
 */
export function addErrorContext(client: { middlewareStack: { add: Function } }): void {
    client.middlewareStack.add(
        (next: Function, context: { clientName?: string; commandName?: string }) =>
            async (args: unknown) => {
                try {
                    return await next(args);
                } catch (err) {
                    if (err instanceof Error) {
                        const svc = (context.clientName  ?? "AWS").replace(/Client$/, "");
                        const op  = (context.commandName ?? "Unknown").replace(/Command$/, "");
                        err.message = `AWS:${svc}:${op}: ${err.message}`;
                    }
                    throw err;
                }
            },
        { step: "initialize" },
    );
}

/**
 * Print only the error message to stderr and exit(1).
 * Used in each script's .catch() to suppress stack traces.
 */
export function handleError(err: unknown): never {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
}
