/**
 * Ensures that the Lambda archive exists for the given source hash.
 * Builds only when the archive is missing.
 * Called from scripts/up.ts and scripts/preview.ts before pulumi commands,
 * because Pulumi evaluates FileArchive hashes during the plan phase.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { watchedFiles, computeSourceHash } from "./lambdaSource";

// Absolute paths to lambda/ and pulumi.out/ from src/
const LAMBDA_DIR   = path.resolve(__dirname, "..", "..", "lambda");
const PULUMI_OUT   = path.resolve(__dirname, "..", "pulumi.out");

/**
 * Ensures that the Lambda archive (.cache/{hash}.zip) exists.
 * If the archive already exists, the build is skipped.
 *
 * After a successful build, the source hash is recomputed because the build
 * may update files included in the hash (e.g. Cargo.lock).  If the hash has
 * changed, the archive is renamed so that Pulumi finds it at the correct path.
 *
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

    // Recompute hash after build — the build may have updated watched files
    // (e.g. Cargo.lock when Cargo.toml version changes).
    const newHash = computeSourceHash(watchedFiles(LAMBDA_DIR), LAMBDA_DIR, [lambdaArch]);
    if (newHash !== sourceHash) {
        const newZip = path.join(PULUMI_OUT, ".cache", `${newHash}.zip`);
        fs.renameSync(outputZip, newZip);
        process.stdout.write(`build: source hash changed after build (${sourceHash.slice(0, 12)} -> ${newHash.slice(0, 12)}), archive renamed\n`);
    }
}
