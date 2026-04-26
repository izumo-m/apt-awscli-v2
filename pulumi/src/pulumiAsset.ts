/**
 * PulumiAsset - A class for managing snapshots of arbitrary assets.
 * Following CDK's cdk.out/, assets are placed under the pulumi.out/ directory.
 *
 * Directory structure:
 *   pulumi.out/
 *     assets.{hash}/      Source file snapshot (for diff display)
 *     .cache/
 *       {hash}.bootstrap  Built Lambda binary (addressed by content + extra inputs)
 *
 * Hash is computed by computeSourceHash(files, baseDir, extraInputs).
 * Including architecture in extraInputs means the hash changes when arch changes.
 *
 * The cached bootstrap is consumed by Pulumi via
 *   pulumi.asset.AssetArchive({bootstrap: FileAsset(path)})
 * in src/lambda.ts, which produces a content-based asset hash that is stable
 * across machines for identical source.
 */

import * as fs from "fs";
import * as path from "path";
import { collectFiles } from "./lambdaSource";

export class PulumiAsset {
    readonly hash: string;
    private readonly _sourceFiles: string[];
    private readonly _baseDir: string;

    constructor(hash: string, sourceFiles: string[], baseDir: string) {
        this.hash = hash;
        this._sourceFiles = sourceFiles;
        this._baseDir = baseDir;
    }

    /** Snapshot directory: {outDir}/assets.{hash} */
    snapshotDir(outDir: string): string {
        return path.join(outDir, `assets.${this.hash}`);
    }

    /** Create a snapshot (idempotent). Skips if the target directory already exists. */
    createSnapshot(outDir: string): void {
        const dir = this.snapshotDir(outDir);
        if (fs.existsSync(dir)) return;
        fs.mkdirSync(dir, { recursive: true });
        for (const srcPath of this._sourceFiles) {
            if (!fs.existsSync(srcPath)) continue;
            const relPath  = path.relative(this._baseDir, srcPath);
            const destPath = path.join(dir, relPath);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(srcPath, destPath);
        }
    }

    /** Returns a map of current source files (relPath → absPath). For diff comparison. */
    sourceFileMap(): Map<string, string> {
        return new Map(
            this._sourceFiles
                .filter(f => fs.existsSync(f))
                .map(f => [path.relative(this._baseDir, f), f]),
        );
    }

    /** Returns a set of relative file paths in the snapshot. For diff comparison. */
    snapshotFileSet(outDir: string): Set<string> {
        const dir = this.snapshotDir(outDir);
        return new Set(collectFiles(dir).map(f => path.relative(dir, f)));
    }
}
