/**
 * Create and configure the S3 bucket for Pulumi backend state.
 *
 * Usage:
 *   npm run bootstrap [-- [--backend <s3url>] [--versioning <n>]]
 *
 * --backend can also be set via PULUMI_BACKEND_URL environment variable.
 * Command-line arguments take precedence over environment variables.
 *
 * Region follows the AWS SDK default resolution order:
 *   AWS_REGION env var > AWS_DEFAULT_REGION env var > ~/.aws/config setting
 *
 * Prerequisites:
 *   - AWS credentials configured (AWS_PROFILE / AWS_ACCESS_KEY_ID etc.)
 */

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
import { handleError, addErrorContext, getBackendS3 } from "./preflight";

// ─── Help ─────────────────────────────────────────────────────────────────────

const USAGE = `\
Usage:
  npm run bootstrap [-- [options]]

Options:
  --backend <url>   S3 backend URL (default: $PULUMI_BACKEND_URL)
  --versioning <n>  S3 object versioning on the state bucket.
                    -1 = keep all versions (unlimited)
                     0 = disable versioning (default)
                     N = keep latest N non-current versions.

Environment variables:
  PULUMI_BACKEND_URL          S3 backend URL (e.g. s3://my-pulumi-state)
`;

// ─── Argument Parser ──────────────────────────────────────────────────────────

interface BootstrapArgs {
    backend:    string | undefined;
    versioning: number;
}

function parseArgs(argv: string[]): BootstrapArgs {
    let backend:    string | undefined;
    let versioning = 0;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--backend" && i + 1 < argv.length) {
            backend = argv[++i];
        } else if (arg === "--versioning" && i + 1 < argv.length) {
            const n = parseInt(argv[++i], 10);
            if (isNaN(n) || n < -1) {
                console.error("Error: --versioning must be -1 (unlimited), 0 (disabled), or a positive integer.");
                process.exit(1);
            }
            versioning = n;
        } else {
            console.error(`Error: unknown option "${arg}".\n`);
            process.stdout.write(USAGE);
            process.exit(1);
        }
    }

    return { backend, versioning };
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

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (args.backend) process.env["PULUMI_BACKEND_URL"] = args.backend;

    const backend = getBackendS3();
    if (!backend) {
        process.stderr.write("Error: backend URL is required (--backend or $PULUMI_BACKEND_URL).\n\n");
        process.stdout.write(USAGE);
        process.exit(1);
    }

    const keepVersions = args.versioning;
    const vDesc = keepVersions === -1 ? "unlimited (-1)"
                : keepVersions ===  0 ? "disabled (0)"
                : `${keepVersions} versions`;

    console.log(`backend    : ${backend.url}`);
    console.log(`versioning : ${vDesc}`);
    console.log();

    const s3 = new S3Client({});
    addErrorContext(s3);

    await ensureBucket(s3, backend.bucket, keepVersions);

    console.log(`
Bootstrap complete. Next steps:
  pulumi login ${backend.url}
  pulumi stack init <name>        (or: pulumi stack select <name>)
  npm run restore-config <name>   (restore Pulumi.<name>.yaml from state)
`);
}

main().catch(handleError);
