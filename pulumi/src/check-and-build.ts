/**
 * Ensures that the Lambda archive exists for the given source hash.
 * Builds only when the archive is missing.
 * Imported and called from scripts/up.ts and scripts/preview.ts.
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
 * Ensures that the Lambda archive (.cache/{hash}.zip) exists.
 * If the archive already exists, the build is skipped.
 * @param sourceHash    Current source hash
 * @param lambdaArch    Lambda architecture (arm64 / x86_64)
 */
export function checkAndBuild(sourceHash: string, lambdaArch: string): void {
    const outputZip = path.join(PULUMI_OUT, ".cache", `${sourceHash}.zip`);

    // Skip if archive already exists
    if (fs.existsSync(outputZip) && fs.statSync(outputZip).size > 0) {
        process.stdout.write("build: skip (archive already exists)\n");
        return;
    }

    // In CI (GitHub Actions), use build-local (no Docker, tools pre-installed in container)
    const buildTask = process.env.CI ? "build-local" : "build";
    process.stdout.write(`build: running cargo make ${buildTask} (arch: ${lambdaArch})\n`);

    // Create output directory and delete old files before building.
    // This prevents build tools from skipping based on target timestamps.
    fs.mkdirSync(path.dirname(outputZip), { recursive: true });
    if (fs.existsSync(outputZip)) fs.unlinkSync(outputZip);

    const result = spawnSync("cargo", ["make", buildTask], {
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
