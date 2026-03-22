/**
 * S3 bucket management script for Pulumi backend
 *
 * Usage:
 *   npm run bootstrap [versioning=<n>]
 *
 * Required environment variables:
 *   APT_AWSCLI_V2_BACKEND=s3://bucket-state[/prefix]
 *   APT_AWSCLI_V2_STACK=dev
 *
 * Region follows the AWS SDK default resolution order:
 *   AWS_REGION env var > AWS_DEFAULT_REGION env var > ~/.aws/config setting
 *
 * Prerequisites:
 *   - AWS credentials configured (AWS_PROFILE / AWS_ACCESS_KEY_ID etc.)
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import {
    S3Client,
    CreateBucketCommand,
    DeleteBucketCommand,
    DeleteObjectsCommand,
    HeadBucketCommand,
    ListObjectVersionsCommand,
    PutBucketVersioningCommand,
    PutBucketLifecycleConfigurationCommand,
    DeleteBucketLifecycleCommand,
} from "@aws-sdk/client-s3";
import { handleError, addErrorContext, getBackendS3, PULUMI_DIR } from "./preflight";

// ─── Help ─────────────────────────────────────────────────────────────────────

const USAGE = `\
Usage:
  npm run bootstrap [versioning=<n>]

Required env vars:
  APT_AWSCLI_V2_BACKEND=s3://bucket-state[/prefix]
  APT_AWSCLI_V2_STACK=<stack>

Optional env vars:
  PULUMI_CONFIG_PASSPHRASE=   (skip passphrase prompt)
  PULUMI_PAGER=               (disable pager)

Options:
  versioning=<n>  Configure S3 object versioning on the state bucket.
                  -1 = keep all versions (unlimited)
                   0 = disable versioning (default)
                   N = keep latest N non-current versions.
`;

// ─── Argument Parser ──────────────────────────────────────────────────────────

function parseOptions(pairs: string[]): Record<string, string> {
    const opts: Record<string, string> = {};
    for (const pair of pairs) {
        const eq = pair.indexOf("=");
        if (eq === -1) {
            console.error(`Error: invalid option "${pair}" (expected key=value).`);
            process.exit(1);
        }
        opts[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return opts;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function confirm(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
        });
    });
}

// ─── S3 Versioning Configuration ──────────────────────────────────────────────

async function applyVersioning(s3: S3Client, bucket: string, keepVersions: number): Promise<void> {
    if (keepVersions === 0) {
        console.log("Deleting lifecycle rule...");
        await s3.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
        return;
    }

    console.log("Enabling versioning...");
    await s3.send(new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
    }));

    if (keepVersions > 0) {
        console.log("Configuring lifecycle rule...");
        await s3.send(new PutBucketLifecycleConfigurationCommand({
            Bucket: bucket,
            LifecycleConfiguration: {
                Rules: [{
                    ID: "keep-noncurrent-versions",
                    Status: "Enabled",
                    Filter: { Prefix: "" },
                    NoncurrentVersionExpiration: {
                        NoncurrentDays: 1,
                        NewerNoncurrentVersions: keepVersions,
                    },
                }],
            },
        }));
    } else {
        // keepVersions === -1: delete lifecycle rule if it still exists
        console.log("Deleting lifecycle rule...");
        await s3.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
    }
}

// ─── S3 Bucket Creation ──────────────────────────────────────────────────────

/**
 * Check and create the state bucket.
 * Displays a confirmation prompt before creating if the bucket does not exist.
 */
async function ensureBucket(s3: S3Client, bucket: string, keepVersions: number): Promise<void> {
    let bucketExists = false;
    try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        bucketExists = true;
    } catch (e: any) {
        if (e.$metadata?.httpStatusCode !== 404 && e.name !== "NotFound") throw e;
    }

    if (bucketExists) {
        console.log(`State bucket already exists: ${bucket}`);
    } else {
        const ok = await confirm(`State bucket "${bucket}" does not exist. Create it? [y/N] `);
        if (!ok) {
            console.log("Aborted.");
            process.exit(0);
        }
        const region = await s3.config.region();
        await s3.send(new CreateBucketCommand({
            Bucket: bucket,
            ...(region !== "us-east-1" && {
                CreateBucketConfiguration: { LocationConstraint: region as any },
            }),
        }));
        console.log(`Created state bucket: ${bucket}`);
    }

    await applyVersioning(s3, bucket, keepVersions);
}

// ─── Delete All Versions + Delete Bucket ─────────────────────────────────────

export async function destroyBucket(bucket: string): Promise<void> {
    const s3 = new S3Client({});
    addErrorContext(s3);

    try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (e: any) {
        if (e.$metadata?.httpStatusCode === 404 || e.name === "NotFound") {
            console.log(`Bucket not found: ${bucket}`);
            return;
        }
        throw e;
    }

    console.log(`Deleting all object versions in: ${bucket}`);
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    while (true) {
        const res = await s3.send(new ListObjectVersionsCommand({
            Bucket: bucket,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
        }));

        const objects = [
            ...(res.Versions      ?? []),
            ...(res.DeleteMarkers ?? []),
        ].map(o => ({ Key: o.Key!, VersionId: o.VersionId! }));

        if (objects.length > 0) {
            await s3.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: objects },
            }));
            console.log(`  Deleted ${objects.length} object(s).`);
        }

        if (!res.IsTruncated) break;
        keyMarker       = res.NextKeyMarker;
        versionIdMarker = res.NextVersionIdMarker;
    }

    console.log(`Deleting bucket: ${bucket}`);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    console.log("Bucket deleted.");
}

// ─── pulumi stack init / select ──────────────────────────────────────────────

/**
 * Try pulumi stack select, and if it fails:
 * - "stack does not exist" error → run stack init
 * - Other errors (auth failure, etc.) → print to stderr and exit
 */
function selectOrInitStack(stackName: string, pulumiEnv: NodeJS.ProcessEnv): void {
    const selectResult = spawnSync(
        "pulumi", ["stack", "select", stackName],
        { cwd: PULUMI_DIR, env: pulumiEnv, stdio: ["inherit", "inherit", "pipe"], encoding: "utf8" },
    );

    if (selectResult.status === 0) {
        console.log(`Stack "${stackName}" selected.`);
        return;
    }

    const stderr = (selectResult.stderr ?? "").trim();
    const isNotFound = /no stack named|does not exist/i.test(stderr);
    if (!isNotFound) {
        if (stderr) process.stderr.write(stderr + "\n");
        process.stderr.write(`Error: pulumi stack select failed (exit ${selectResult.status}).\n`);
        process.exit(selectResult.status ?? 1);
    }

    // Stack does not exist → create new
    console.log(`Stack "${stackName}" not found. Creating...`);
    const initResult = spawnSync(
        "pulumi", ["stack", "init", stackName],
        { cwd: PULUMI_DIR, env: pulumiEnv, stdio: "inherit" },
    );
    if (initResult.error) throw initResult.error;
    if (initResult.status !== 0) process.exit(initResult.status ?? 1);
}

// ─── Sync Pulumi.{stack}.yaml with Stack Tags ────────────────────────────────

/**
 * Sync configuration files during bootstrap (using Pulumi state stack tags).
 *
 * - Tag present + local absent → restore from tag
 * - Tag present + local present → prompt to overwrite (local changes will be lost)
 * - Tag absent + local present → use local as-is (new setup)
 * - Tag absent + local absent → error (prompt to copy from sample)
 */
async function syncStackConfig(stackName: string, pulumiEnv: NodeJS.ProcessEnv): Promise<void> {
    const configFileName = `Pulumi.${stackName}.yaml`;
    const localPath      = path.join(PULUMI_DIR, configFileName);
    const localExists    = fs.existsSync(localPath);

    // Read from Pulumi state stack tags
    const tagResult = spawnSync(
        "pulumi", ["stack", "tag", "get", "stack-config", "--stack", stackName],
        { cwd: PULUMI_DIR, env: pulumiEnv, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
    );

    let tagContent: string | null = null;
    if (tagResult.status === 0) {
        const encoded = tagResult.stdout.trim();
        if (encoded) {
            try { tagContent = Buffer.from(encoded, "base64").toString("utf8"); } catch { /* invalid */ }
        }
    }

    if (tagContent !== null) {
        if (localExists) {
            const ok = await confirm(
                `${configFileName} exists locally and in Pulumi state.\n` +
                `Overwrite local with Pulumi state version? (local changes will be lost) [y/N] `
            );
            if (!ok) {
                console.log(`Keeping local ${configFileName}.`);
                return;
            }
        }
        fs.writeFileSync(localPath, tagContent, "utf8");
        console.log(`Restored ${configFileName} from Pulumi stack state.`);
    } else {
        if (!localExists) {
            process.stderr.write(`Error: ${configFileName} not found locally or in Pulumi stack state.\n`);
            process.stderr.write(`For a new setup, copy and edit the sample:\n`);
            process.stderr.write(`  cp Pulumi.sample.yaml ${configFileName}\n`);
            process.stderr.write(`  $EDITOR ${configFileName}\n`);
            process.stderr.write(`Then re-run: npm run bootstrap\n`);
            process.exit(1);
        }
        console.log(`${configFileName} not found in Pulumi stack state. Using local file.`);
    }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // 1. Verify required environment variables
    const backend = getBackendS3();
    if (!backend) {
        process.stderr.write("Error: APT_AWSCLI_V2_BACKEND is not set.\n\n");
        process.stdout.write(USAGE);
        process.exit(1);
    }
    const stackName = process.env["APT_AWSCLI_V2_STACK"];
    if (!stackName) {
        process.stderr.write("Error: APT_AWSCLI_V2_STACK is not set.\n\n");
        process.stdout.write(USAGE);
        process.exit(1);
    }

    // 2. Parse options (versioning=N only)
    const opts = parseOptions(process.argv.slice(2));
    let keepVersions = 0;
    if ("versioning" in opts) {
        const n = parseInt(opts["versioning"], 10);
        if (isNaN(n) || n < -1) {
            console.error("Error: versioning must be -1 (unlimited), 0 (disabled), or a positive integer.");
            process.exit(1);
        }
        keepVersions = n;
    }

    const vDesc = keepVersions === -1 ? "unlimited (-1)"
                : keepVersions ===  0 ? "disabled (0)"
                : `${keepVersions} versions`;

    console.log(`backend    : ${backend.url}`);
    console.log(`stack      : ${stackName}`);
    console.log(`versioning : ${vDesc}`);
    console.log();

    const s3 = new S3Client({});
    addErrorContext(s3);

    // 3. Create S3 bucket (create after confirmation if not exists) + versioning configuration
    await ensureBucket(s3, backend.bucket, keepVersions);

    // 4. pulumi stack select / init (required before reading tags)
    console.log();
    const pulumiEnv = { ...process.env, PULUMI_BACKEND_URL: backend.url };
    selectOrInitStack(stackName, pulumiEnv);

    // 5. Sync Pulumi.{stack}.yaml with stack tags
    console.log();
    await syncStackConfig(stackName, pulumiEnv);

    // 6. Completion message
    const configFileName = `Pulumi.${stackName}.yaml`;
    console.log(`
Bootstrap complete.
Edit ${configFileName} if needed, then run:
  npm run up
`);
}

main().catch(handleError);
