/**
 * Restore Pulumi.{stack}.yaml from Pulumi state stack tags.
 *
 * Usage:
 *   npm run restore-config
 *
 * Prerequisites:
 *   pulumi login <backendUrl>
 *   pulumi stack select <name>
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { spawnSync } from "child_process";
import { handleError, getCurrentStackName, PULUMI_DIR } from "./preflight";

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
 * Restore Pulumi.{stack}.yaml from stack tags.
 *
 * - Tag present + local absent → restore from tag
 * - Tag present + local present → prompt to overwrite (local changes will be lost)
 * - Tag absent + local present → keep local as-is
 * - Tag absent + local absent → error (prompt to copy from sample)
 */
async function main(): Promise<void> {
    const stackName      = getCurrentStackName();
    const configFileName = `Pulumi.${stackName}.yaml`;
    const localPath      = path.join(PULUMI_DIR, configFileName);
    const localExists    = fs.existsSync(localPath);

    // Read from Pulumi state stack tags
    const tagResult = spawnSync(
        "pulumi", ["stack", "tag", "get", "stack-config"],
        { cwd: PULUMI_DIR, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
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
            process.exit(1);
        }
        console.log(`${configFileName} not found in Pulumi stack state. Using local file as-is.`);
    }
}

main().catch(handleError);
