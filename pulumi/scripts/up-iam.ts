/**
 * Script to deploy only IAM resources (TypeScript version of up-iam.sh).
 * Run by an administrator with IAM permissions (for initial deployment or IAM changes).
 * Docker / cargo environment is not required. bootstrap.zip is also not needed.
 *
 * If bootstrap.zip does not exist, pulumi/src/lambda.ts uses an in-memory empty archive
 * as a fallback, so the plan phase passes successfully.
 * --target iam* ensures Lambda resources are not applied.
 *
 * Usage:
 *   npm run up:iam [-- <pulumi up options (e.g. --yes)>]
 */

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { PULUMI_DIR, getCurrentStackName, getPulumiEnv, ensureStackConfig } from "./preflight";

const stackName = getCurrentStackName();
ensureStackConfig(stackName);

const pulumiEnv = getPulumiEnv();

// Get project name from Pulumi.yaml
const pulumiYaml = fs.readFileSync(path.join(PULUMI_DIR, "Pulumi.yaml"), "utf8");
const projectMatch = pulumiYaml.match(/^name:\s*(.+)$/m);
if (!projectMatch) {
    console.error("Error: could not read project name from Pulumi.yaml.");
    process.exit(1);
}
const project = projectMatch[1].trim();

const target = `urn:pulumi:${stackName}::${project}::aws:iam*::*`;

const result = spawnSync(
    "pulumi", ["up", "--stack", stackName, `--target=${target}`, ...process.argv.slice(2)],
    { cwd: PULUMI_DIR, env: pulumiEnv, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 0);
