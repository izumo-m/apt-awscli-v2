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
import { LocalWorkspace } from "@pulumi/pulumi/automation";
import {
    PULUMI_DIR, LAMBDA_DIR,
    getLambdaArch, createLambdaAsset, showSourceDiff, handleError,
    getPulumiEnv, getCurrentStackName, ensureStackConfig,
    extractDeployedHash,
} from "./preflight";
import { checkAndBuild } from "../src/check-and-build";

async function main(): Promise<void> {
    const stackName = getCurrentStackName();
    ensureStackConfig(stackName);

    const pulumiEnv  = getPulumiEnv();
    const lambdaArch = getLambdaArch();

    // Build if needed — the archive must exist before Pulumi evaluates the FileArchive.
    const currentHash = createLambdaAsset(LAMBDA_DIR, lambdaArch).hash;
    checkAndBuild(currentHash, lambdaArch);

    if (process.argv.includes("--diff")) {
        try {
            const stack = await LocalWorkspace.selectStack(
                { workDir: PULUMI_DIR, stackName },
                pulumiEnv["PULUMI_BACKEND_URL"]
                    ? { envVars: { PULUMI_BACKEND_URL: pulumiEnv["PULUMI_BACKEND_URL"] } }
                    : undefined,
            );
            const deployment = await stack.exportStack();
            const deployedHash = extractDeployedHash(deployment);
            if (deployedHash) showSourceDiff(deployedHash, lambdaArch);
        } catch (e) {
            console.error(`Warning: could not retrieve deployed state: ${(e as Error).message}`);
        }
    }

    const result = spawnSync(
        "pulumi", ["preview", "--stack", stackName, ...process.argv.slice(2)],
        { cwd: PULUMI_DIR, env: pulumiEnv, stdio: "inherit" },
    );

    process.exit(result.status ?? 0);
}

main().catch(handleError);
