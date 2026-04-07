/**
 * Wrapper for pulumi preview.
 * When --diff is specified, displays the source diff against the deployed code beforehand.
 *
 * Usage:
 *   npm run preview [-- <pulumi preview options>]
 *   npm run preview -- --diff    (also show source diff)
 *
 * Prerequisites:
 *   pulumi login <backendUrl>   (or export PULUMI_BACKEND_URL=<backendUrl>)
 *   pulumi stack select <name>
 */

import { spawnSync } from "child_process";
import {
    PULUMI_DIR,
    getLambdaArch, handleError,
    showSourceDiff, extractDeployedHash,
} from "./preflight";

function main(): void {
    if (process.argv.includes("--diff")) {
        try {
            const exported = spawnSync(
                "pulumi", ["stack", "export"],
                { cwd: PULUMI_DIR, stdio: ["inherit", "pipe", "inherit"] },
            );
            if (exported.error) throw exported.error;
            if (exported.status === 0) {
                const deployment = JSON.parse(exported.stdout.toString());
                const deployedHash = extractDeployedHash(deployment);
                if (deployedHash) showSourceDiff(deployedHash, getLambdaArch());
            }
        } catch (e) {
            console.error(`Warning: could not retrieve deployed state: ${(e as Error).message}`);
        }
    }

    const result = spawnSync(
        "pulumi", ["preview", ...process.argv.slice(2)],
        { cwd: PULUMI_DIR, stdio: "inherit" },
    );

    if (result.error) throw result.error;

    process.exit(result.status ?? 0);
}

try { main(); } catch (e) { handleError(e); }
