/**
 * Wrapper for pulumi up.
 * Runs a build before pulumi up if the Lambda source has changed (idempotent).
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
    saveStackConfigToTag, getDeployedHash, handleError,
} from "./preflight";
import { checkAndBuild } from "../src/check-and-build";

async function main(): Promise<void> {
    const stackName = getCurrentStackName();
    ensureStackConfig(stackName);

    const lambdaArch = getLambdaArch();
    const pulumiEnv  = getPulumiEnv();

    // Compare current source hash with deployed hash in state to determine if a build is needed
    const currentHash  = createLambdaAsset(LAMBDA_DIR, lambdaArch).hash;
    const deployedHash = await getDeployedHash(stackName, pulumiEnv);
    checkAndBuild(currentHash, deployedHash, lambdaArch);

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

main().catch(handleError);
