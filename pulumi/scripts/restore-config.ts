/**
 * Restore Pulumi.{stack}.yaml from the Pulumi state bucket.
 *
 * The file is kept in sync by an `aws.s3.BucketObjectv2` resource declared in
 * src/index.ts, which uploads it to `s3://<state-bucket>/stack-configs/Pulumi.{stack}.yaml`
 * on every `pulumi up`. This script reads that object directly via the AWS SDK
 * (no Pulumi stack selection required).
 *
 * Usage:
 *   npm run restore-config <stack>
 *
 * Prerequisites:
 *   PULUMI_BACKEND_URL=s3://<state-bucket>
 *   AWS credentials with GetObject permission on the state bucket
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { handleError, addErrorContext, getBackendS3, PULUMI_DIR } from "./preflight";

function confirm(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
        });
    });
}

/**
 * Restore Pulumi.{stack}.yaml from the state bucket.
 *
 * - Remote present + local absent  → restore from S3
 * - Remote present + local present → prompt to overwrite (local changes will be lost)
 * - Remote absent  + local present → keep local as-is
 * - Remote absent  + local absent  → error (prompt to copy from sample)
 */
async function main(): Promise<void> {
    const stackName = process.argv[2];
    if (!stackName) {
        process.stderr.write("Usage: npm run restore-config <stack>\n");
        process.exit(1);
    }

    const backend = getBackendS3();
    if (!backend) {
        process.stderr.write("Error: PULUMI_BACKEND_URL must be set to an s3:// URL.\n");
        process.exit(1);
    }

    const configFileName = `Pulumi.${stackName}.yaml`;
    const localPath      = path.join(PULUMI_DIR, configFileName);
    const localExists    = fs.existsSync(localPath);

    const key = `stack-configs/${configFileName}`;
    const s3  = new S3Client({});
    addErrorContext(s3);

    let remoteContent: string | null = null;
    try {
        const res = await s3.send(new GetObjectCommand({ Bucket: backend.bucket, Key: key }));
        remoteContent = (await res.Body!.transformToString("utf8")) ?? "";
    } catch (e: any) {
        const status = e.$metadata?.httpStatusCode;
        if (e.name !== "NoSuchKey" && status !== 404) throw e;
    }

    if (remoteContent !== null) {
        if (localExists) {
            const ok = await confirm(
                `${configFileName} already exists locally.\n` +
                `Replace it with the version stored in s3://${backend.bucket}/${key}?\n` +
                `  WARNING: Any local edits to ${configFileName} will be lost.\n` +
                `Proceed? [y/N] `
            );
            if (!ok) {
                console.log(`Keeping local ${configFileName}.`);
                return;
            }
        }
        fs.writeFileSync(localPath, remoteContent, "utf8");
        console.log(`Restored ${configFileName} from s3://${backend.bucket}/${key}`);
    } else {
        if (!localExists) {
            process.stderr.write(`Error: ${configFileName} not found locally or at s3://${backend.bucket}/${key}.\n`);
            process.stderr.write(`For a new setup, copy and edit the sample:\n`);
            process.stderr.write(`  cp Pulumi.sample.yaml ${configFileName}\n`);
            process.stderr.write(`  $EDITOR ${configFileName}\n`);
            process.exit(1);
        }
        console.log(`${configFileName} not found at s3://${backend.bucket}/${key}. Using local file as-is.`);
    }
}

main().catch(handleError);
