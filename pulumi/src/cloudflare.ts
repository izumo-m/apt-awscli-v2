/**
 * Cloudflare Worker resources (opt-in via aptAwscliV2:cloudflareEnabled).
 *
 * Manages:
 *   - WorkersScript           — uploads `cloudflare/index.js` as the Worker
 *                               with ORIGIN_BASE_URL plain-text binding
 *                               derived from aptAwscliV2:s3Uri
 *   - WorkersCustomDomain     — created only when cloudflareCustomDomain is set
 *
 * Does NOT manage:
 *   - DNS records             — Cloudflare auto-creates these for custom domains
 *   - SSL certificates        — auto-issued via Universal SSL
 *   - Worker secrets          — managed via the Cloudflare dashboard or API
 *   - Cache rules / settings  — out of scope for this project
 *
 * Authentication:
 *   The Pulumi Cloudflare provider reads CLOUDFLARE_API_TOKEN from the
 *   environment. The token must have:
 *     - Account → Workers Scripts: Edit
 *     - Zone    → Workers Routes: Edit   (only if cloudflareCustomDomain is set)
 *     - Zone    → Zone: Read              (only if cloudflareCustomDomain is set)
 *   This token is OPERATOR-only — it is never stored in Pulumi state.
 */

import * as fs from "fs";
import * as path from "path";
import * as cloudflare from "@pulumi/cloudflare";
import { AppConfig } from "./config";

export interface CloudflareResult {
    scriptName: string;
}

const WORKER_SCRIPT_NAME = "apt-awscli-v2-proxy";
const WORKER_SOURCE_PATH = path.resolve(__dirname, "..", "..", "cloudflare", "index.js");
const WORKER_COMPATIBILITY_DATE = "2026-04-19";

/**
 * Create the Cloudflare Worker and (optionally) its custom domain binding.
 * Caller MUST guard with `if (cfg.cloudflareEnabled)` — this function assumes
 * required fields are present.
 */
export function createCloudflareWorker(cfg: AppConfig): CloudflareResult {
    if (!cfg.cloudflareEnabled) {
        throw new Error("createCloudflareWorker called with cloudflareEnabled=false");
    }
    if (!cfg.cloudflareAccountId || !cfg.cloudflareZoneId) {
        throw new Error("createCloudflareWorker requires cloudflareAccountId and cloudflareZoneId");
    }

    const accountId = cfg.cloudflareAccountId;
    const zoneId    = cfg.cloudflareZoneId;
    const originUrl = deriveOriginUrl(cfg.s3Uri);

    if (!fs.existsSync(WORKER_SOURCE_PATH)) {
        throw new Error(`Worker source file not found: ${WORKER_SOURCE_PATH}`);
    }
    const content = fs.readFileSync(WORKER_SOURCE_PATH, "utf8");

    // Worker script: uploads index.js with ORIGIN_BASE_URL bound from s3Uri.
    // ORIGIN_BASE_URL is treated as a secret because production deployments
    // include a random UUID prefix in s3Uri to prevent direct S3 access
    // (EDoS mitigation). Leaking the origin URL would defeat that gate.
    const script = new cloudflare.WorkersScript(`${cfg.resourcePrefix}-worker`, {
        accountId,
        scriptName:        WORKER_SCRIPT_NAME,
        content,
        mainModule:        "index.js",
        compatibilityDate: WORKER_COMPATIBILITY_DATE,
        bindings: [
            {
                type: "secret_text",
                name: "ORIGIN_BASE_URL",
                text: originUrl,
            },
        ],
    });

    // Optional: bind a custom domain so the Worker is reachable at
    // https://<cloudflareCustomDomain>. Without this the Worker is only
    // accessible via workers.dev (if enabled) or whatever route is set on
    // the Cloudflare dashboard.
    if (cfg.cloudflareCustomDomain) {
        new cloudflare.WorkersCustomDomain(
            `${cfg.resourcePrefix}-worker-domain`,
            {
                accountId,
                zoneId,
                hostname: cfg.cloudflareCustomDomain,
                service:  WORKER_SCRIPT_NAME,
            },
            { dependsOn: [script] },
        );
    }

    return { scriptName: WORKER_SCRIPT_NAME };
}

/**
 * Convert s3://bucket/prefix/ into a public S3 HTTPS URL the Worker can
 * use as ORIGIN_BASE_URL. We use the global virtual-hosted form
 *   https://<bucket>.s3.amazonaws.com/<prefix>
 * which works regardless of region. Cloudflare follows the 307 redirect
 * to the regional endpoint on first request.
 */
function deriveOriginUrl(s3Uri: string): string {
    const m = s3Uri.match(/^s3:\/\/([^/]+)(?:\/(.*))?$/);
    if (!m) throw new Error(`Invalid s3Uri: ${s3Uri}`);
    const bucket = m[1];
    const prefix = (m[2] ?? "").replace(/\/+$/, "");
    const base   = `https://${bucket}.s3.amazonaws.com`;
    return prefix ? `${base}/${prefix}` : base;
}
