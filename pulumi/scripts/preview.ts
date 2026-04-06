/**
 * Wrapper for pulumi preview.
 * Builds the Lambda archive if needed (Pulumi evaluates FileArchive during the plan phase).
 * When --diff is specified, displays the source diff against the deployed code beforehand.
 *
 * Usage:
 *   npm run preview [-- <pulumi preview options>]
 *   npm run preview -- --diff    (also show source diff)
 */

import { spawnSync } from "child_process";
import {
    PULUMI_DIR, LAMBDA_DIR,
    getLambdaArch, createLambdaAsset, handleError,
    getPulumiEnv, getCurrentStackName, ensureStackConfig,
    showSourceDiff, extractDeployedHash,
} from "./preflight";
import { checkAndBuild } from "../src/check-and-build";
import { generateIndexHtml } from "../src/indexHtml";

function main(): void {
    const stackName = getCurrentStackName();
    ensureStackConfig(stackName);

    const lambdaArch = getLambdaArch();
    const pulumiEnv  = getPulumiEnv();

    // Build if needed — the archive must exist before Pulumi evaluates the FileArchive.
    const currentHash = createLambdaAsset(LAMBDA_DIR, lambdaArch).hash;
    checkAndBuild(currentHash, lambdaArch);

    // Generate index.html from README.md (must exist before Pulumi evaluates BucketObjectv2).
    generateIndexHtml();

    if (process.argv.includes("--diff")) {
        try {
            const exported = spawnSync(
                "pulumi", ["stack", "export", "--stack", stackName],
                { cwd: PULUMI_DIR, env: pulumiEnv, stdio: ["inherit", "pipe", "inherit"] },
            );
            if (exported.error) throw exported.error;
            if (exported.status === 0) {
                const deployment = JSON.parse(exported.stdout.toString());
                const deployedHash = extractDeployedHash(deployment);
                if (deployedHash) showSourceDiff(deployedHash, lambdaArch);
            }
        } catch (e) {
            console.error(`Warning: could not retrieve deployed state: ${(e as Error).message}`);
        }
    }

    const result = spawnSync(
        "pulumi", ["preview", "--stack", stackName, ...process.argv.slice(2)],
        { cwd: PULUMI_DIR, env: pulumiEnv, stdio: "inherit" },
    );

    if (result.error) throw result.error;

    process.exit(result.status ?? 0);
}

try { main(); } catch (e) { handleError(e); }
