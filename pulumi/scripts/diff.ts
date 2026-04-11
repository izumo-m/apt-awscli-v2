/**
 * Show a unified diff between the currently deployed Lambda source and the
 * local working copy.
 *
 * Reads the deployed source hash from stack state (`pulumi stack export`) and
 * compares it against `pulumi.out/assets.{deployedHash}/`, which is captured
 * on every build by src/check-and-build.ts.
 *
 * Usage:
 *   npm run diff
 *
 * Prerequisites:
 *   pulumi login <backendUrl>
 *   pulumi stack select <name>
 */

import { spawnSync } from "child_process";
import {
    PULUMI_DIR,
    getLambdaArch, handleError,
    showSourceDiff, extractDeployedHash,
} from "./preflight";

function main(): void {
    const exported = spawnSync(
        "pulumi", ["stack", "export"],
        { cwd: PULUMI_DIR, stdio: ["inherit", "pipe", "inherit"] },
    );
    if (exported.error) throw exported.error;
    if (exported.status !== 0) {
        process.exit(exported.status ?? 1);
    }

    const deployment   = JSON.parse(exported.stdout.toString());
    const deployedHash = extractDeployedHash(deployment);
    if (!deployedHash) {
        console.log("No deployed Lambda source hash found in stack state.");
        return;
    }

    showSourceDiff(deployedHash, getLambdaArch());
}

try { main(); } catch (e) { handleError(e); }
