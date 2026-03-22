/**
 * Compares the deployed hash with the current source hash, and runs a build if they differ.
 * Imported and called from scripts/up.ts. Not executed as an external command.
 *
 * Paths are computed from LAMBDA_DIR / PULUMI_OUT_DIR (shared with preflight.ts),
 * avoiding recording absolute paths in Pulumi state.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

// Absolute paths to lambda/ and pulumi.out/ from src/
const LAMBDA_DIR   = path.resolve(__dirname, "..", "..", "lambda");
const PULUMI_OUT   = path.resolve(__dirname, "..", "pulumi.out");

/**
 * Compares the current source hash with the deployed hash, and runs a build only if they differ.
 * @param currentHash   Current source hash
 * @param deployedHash  Deployed hash recorded in state ("" if not available)
 * @param lambdaArch    Lambda architecture (arm64 / x86_64)
 */
export function checkAndBuild(currentHash: string, deployedHash: string, lambdaArch: string): void {
    const outputZip = path.join(PULUMI_OUT, ".cache", `${currentHash}.zip`);

    // If matches deployed hash, no Lambda code change → skip
    if (currentHash === deployedHash) {
        process.stdout.write("build: skip (no source change since last deployment)\n");
        return;
    }

    process.stdout.write(`build: running cargo make build (arch: ${lambdaArch})\n`);

    // Create output directory and delete old files before building.
    // This prevents build tools from skipping based on target timestamps.
    fs.mkdirSync(path.dirname(outputZip), { recursive: true });
    if (fs.existsSync(outputZip)) fs.unlinkSync(outputZip);

    const result = spawnSync("cargo", ["make", "build"], {
        env: {
            ...process.env,
            APT_AWSCLI_V2_LAMBDA_ARCH: lambdaArch,
            APT_AWSCLI_V2_OUTPUT_ZIP:  outputZip,
        },
        stdio: "inherit",
        cwd: LAMBDA_DIR,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
