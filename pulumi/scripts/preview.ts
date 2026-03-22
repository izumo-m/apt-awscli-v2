/**
 * Wrapper for pulumi preview.
 * When --diff is specified, displays the source diff against the deployed code beforehand.
 * No build is performed during preview (the buildLambda Command handles that during up).
 *
 * Usage:
 *   npm run preview [-- <pulumi preview options>]
 *   npm run preview -- --diff    (also show source diff)
 */

import { spawnSync } from "child_process";
import { LocalWorkspace } from "@pulumi/pulumi/automation";
import {
    PULUMI_DIR,
    getLambdaArch, showSourceDiff, handleError,
    getPulumiEnv, getCurrentStackName, ensureStackConfig,
    extractDeployedHash,
} from "./preflight";

async function main(): Promise<void> {
    const stackName = getCurrentStackName();
    ensureStackConfig(stackName);

    const pulumiEnv = getPulumiEnv();

    if (process.argv.includes("--diff")) {
        try {
            const lambdaArch = getLambdaArch();

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
