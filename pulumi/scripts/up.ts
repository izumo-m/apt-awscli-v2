/**
 * Wrapper for pulumi up.
 * After a successful up, saves the current source snapshot (for the next preview --diff).
 * After a successful up, saves Pulumi.{stack}.yaml as a stack tag in Pulumi state.
 *
 * Usage:
 *   npm run up [-- <pulumi up options>]
 *
 * Prerequisites:
 *   pulumi login <backendUrl>   (or export PULUMI_BACKEND_URL=<backendUrl>)
 *   pulumi stack select <name>
 */

import { spawnSync } from "child_process";
import {
    PULUMI_DIR,
    getLambdaArch, getCurrentStackName, handleError,
    createCurrentSnapshot, saveStackConfigToTag,
} from "./preflight";

function main(): void {
    const result = spawnSync(
        "pulumi", ["up", ...process.argv.slice(2)],
        { cwd: PULUMI_DIR, stdio: "inherit" },
    );

    if (result.error) throw result.error;

    if (result.status === 0) {
        createCurrentSnapshot(getLambdaArch());
        saveStackConfigToTag(getCurrentStackName());
    }

    process.exit(result.status ?? 0);
}

try { main(); } catch (e) { handleError(e); }
