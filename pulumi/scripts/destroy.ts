/**
 * Wrapper for pulumi destroy.
 * After successful destroy, prompts to delete the state bucket (if APT_AWSCLI_V2_BACKEND is set).
 *
 * Usage:
 *   npm run destroy [-- <pulumi destroy options>]
 *
 * Prerequisites:
 *   pulumi login <backendUrl>   (or export PULUMI_BACKEND_URL=<backendUrl>)
 *   pulumi stack select <name>
 */

import { spawnSync } from "child_process";
import * as readline from "readline";
import { PULUMI_DIR, getBackendS3, handleError } from "./preflight";
import { destroyBucket } from "./bootstrap";

function confirm(question: string): Promise<boolean> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
        });
    });
}

async function main(): Promise<void> {
    const result = spawnSync(
        "pulumi", ["destroy", ...process.argv.slice(2)],
        { cwd: PULUMI_DIR, stdio: "inherit" },
    );

    if (result.error) throw result.error;

    if (result.status === 0) {
        const backend = getBackendS3();
        if (backend) {
            const ok = await confirm(
                `\nPulumi stack has been destroyed.\n` +
                `Do you also want to delete the state bucket "${backend.url}"? [y/N] `
            );
            if (ok) {
                await destroyBucket(backend.bucket);
            } else {
                console.log("State bucket kept.");
            }
        }
    }

    process.exit(result.status ?? 0);
}

main().catch(handleError);
