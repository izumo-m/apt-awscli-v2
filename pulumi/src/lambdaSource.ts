/**
 * Utility for enumerating Lambda source files and computing hashes.
 * Shared between lambda.ts (Pulumi program) and scripts/preflight.ts (preflight).
 *
 * Watched file definitions are centralized here.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** Recursively collect all file paths in a directory. */
export function collectFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectFiles(full));
        } else {
            results.push(full);
        }
    }
    return results;
}

/**
 * Returns the list of watched files for Lambda source.
 * @param baseDir  Path to the lambda/ directory (relative or absolute)
 */
export function watchedFiles(baseDir: string): string[] {
    return [
        ...collectFiles(path.join(baseDir, "src")),
        ...collectFiles(path.join(baseDir, "metadata")),
        path.join(baseDir, "Cargo.toml"),
        path.join(baseDir, "Cargo.lock"),
        path.join(baseDir, "rust-toolchain.toml"),
    ];
}

/**
 * Compute the source hash.
 * Uses relative paths from baseDir to ensure consistent hash values across user environments.
 * If extraInputs are specified, they are also used as additional hash inputs (e.g., architecture).
 */
export function computeSourceHash(filePaths: string[], baseDir: string, extraInputs: string[] = []): string {
    const hash = crypto.createHash("sha256");
    for (const p of [...filePaths].sort()) {
        if (fs.existsSync(p)) {
            hash.update(path.relative(baseDir, p));
            hash.update(fs.readFileSync(p));
        }
    }
    for (const extra of extraInputs) {
        hash.update(extra);
    }
    return hash.digest("hex");
}
