/**
 * Wrapper for pulumi up.
 * Builds the Lambda archive if needed, then runs pulumi up.
 * After a successful up, saves the current source snapshot (for the next preview --diff).
 * After a successful up, saves Pulumi.{stack}.yaml as a stack tag in Pulumi state.
 *
 * Usage:
 *   npm run up [-- <pulumi up options>]
 */

import { spawnSync } from "child_process";
import {
    PULUMI_DIR, LAMBDA_DIR,
    getLambdaArch, createLambdaAsset, createCurrentSnapshot,
    getPulumiEnv, getCurrentStackName, ensureStackConfig,
    saveStackConfigToTag, handleError,
} from "./preflight";
import { checkAndBuild } from "../src/check-and-build";

function main(): void {
    const stackName = getCurrentStackName();
    ensureStackConfig(stackName);

    const lambdaArch = getLambdaArch();
    const pulumiEnv  = getPulumiEnv();

    // Build if needed — the archive must exist before Pulumi evaluates the FileArchive.
    const currentHash = createLambdaAsset(LAMBDA_DIR, lambdaArch).hash;
    checkAndBuild(currentHash, lambdaArch);

    const result = spawnSync(
        "pulumi", ["up", "--stack", stackName, ...process.argv.slice(2)],
        { cwd: PULUMI_DIR, env: pulumiEnv, stdio: "inherit" },
    );

    if (result.error) throw result.error;

    if (result.status === 0) {
        createCurrentSnapshot(lambdaArch);
        saveStackConfigToTag(stackName, pulumiEnv);
    }

    process.exit(result.status ?? 0);
}

try { main(); } catch (e) { handleError(e); }
