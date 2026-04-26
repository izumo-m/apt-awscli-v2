/**
 * Ensures that the Lambda archive exists for the given source hash, and that
 * a matching source snapshot (assets.{hash}/) exists next to it for later
 * `showSourceDiff` comparisons.
 *
 * Called from src/lambda.ts during Pulumi program evaluation, so running
 * `pulumi preview` or `pulumi up` directly (no wrapper script) is sufficient
 * to keep both the archive and the snapshot up to date.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { watchedFiles, computeSourceHash } from "./lambdaSource";
import { PulumiAsset } from "./pulumiAsset";

// Absolute paths to lambda/ and pulumi.out/ from src/
const LAMBDA_DIR   = path.resolve(__dirname, "..", "..", "lambda");
const PULUMI_OUT   = path.resolve(__dirname, "..", "pulumi.out");

/**
 * Create the assets.{hash}/ source snapshot for the given hash, idempotently.
 * The snapshot captures the current on-disk source files so that a later
 * `showSourceDiff` invocation can compare a deployed hash against this baseline.
 */
function ensureSnapshot(hash: string): void {
    const files = watchedFiles(LAMBDA_DIR);
    new PulumiAsset(hash, files, LAMBDA_DIR).createSnapshot(PULUMI_OUT);
}

/**
 * Ensures that the Lambda bootstrap binary (.cache/{hash}.bootstrap) exists.
 * If the binary already exists, the build is skipped.
 *
 * The bootstrap binary (not a zip) is the cached artifact: lambda.ts wraps it
 * via `pulumi.asset.AssetArchive({bootstrap: FileAsset(...)})`. This makes the
 * Pulumi asset hash content-based (binary SHA256), not zip-bytes-based, so
 * identical source produces identical asset hash across machines and avoids
 * spurious code re-uploads from zip metadata jitter.
 *
 * After a successful build, the source hash is recomputed because the build
 * may update files included in the hash (e.g. Cargo.lock).  If the hash has
 * changed, the binary is renamed so that Pulumi finds it at the correct path.
 *
 * @param sourceHash    Current source hash
 * @param lambdaArch    Lambda architecture (arm64 / x86_64)
 * @returns             The final source hash (may differ from sourceHash if the build updated watched files)
 */
export function checkAndBuild(sourceHash: string, lambdaArch: string): string {
    const outputBootstrap = path.join(PULUMI_OUT, ".cache", `${sourceHash}.bootstrap`);

    // Skip if binary already exists
    if (fs.existsSync(outputBootstrap) && fs.statSync(outputBootstrap).size > 0) {
        process.stdout.write("build: skip (bootstrap already exists)\n");
        ensureSnapshot(sourceHash);
        return sourceHash;
    }

    process.stdout.write(`build: running cargo make build (arch: ${lambdaArch})\n`);

    // Create output directory and delete old files before building.
    // This prevents build tools from skipping based on target timestamps.
    fs.mkdirSync(path.dirname(outputBootstrap), { recursive: true });
    if (fs.existsSync(outputBootstrap)) fs.unlinkSync(outputBootstrap);

    // Clean only the lambda crate so it is recompiled.
    // Dependencies are kept cached.
    spawnSync("cargo", ["make", "clean-package"], {
        env: { ...process.env, APT_AWSCLI_V2_LAMBDA_ARCH: lambdaArch },
        stdio: "inherit",
        cwd: LAMBDA_DIR,
    });

    const result = spawnSync("cargo", ["make", "build"], {
        env: {
            ...process.env,
            APT_AWSCLI_V2_LAMBDA_ARCH:      lambdaArch,
            APT_AWSCLI_V2_OUTPUT_BOOTSTRAP: outputBootstrap,
        },
        stdio: "inherit",
        cwd: LAMBDA_DIR,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Lambda build failed (exit ${result.status})`);

    // Recompute hash after build — the build may have updated watched files
    // (e.g. Cargo.lock when Cargo.toml version changes).
    const newHash = computeSourceHash(watchedFiles(LAMBDA_DIR), LAMBDA_DIR, [lambdaArch]);
    if (newHash !== sourceHash) {
        const newBootstrap = path.join(PULUMI_OUT, ".cache", `${newHash}.bootstrap`);
        fs.renameSync(outputBootstrap, newBootstrap);
        process.stdout.write(`build: source hash changed after build (${sourceHash.slice(0, 12)} -> ${newHash.slice(0, 12)}), binary renamed\n`);
        ensureSnapshot(newHash);
        return newHash;
    }
    ensureSnapshot(sourceHash);
    return sourceHash;
}
