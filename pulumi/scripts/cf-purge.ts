/**
 * cf-purge.ts
 *
 * Manually invalidate Cloudflare edge cache for objects under a given path
 * prefix. Reads the API token from the SSM SecureString parameter
 * configured in `aptAwscliV2:cloudflareSsmParam`, plus the zone ID and
 * public base URL from Pulumi config (non-secret).
 *
 * Useful during development when the Lambda did not run (no S3 diff) but
 * the cache needs to be cleared anyway.
 *
 * Usage:
 *   npm run cf-purge -- --prefix dists/
 *   npm run cf-purge -- --prefix pool/main/awscli-v2/
 *   npm run cf-purge -- --prefix ''            # everything under repo prefix
 *   npm run cf-purge -- --all                  # purge_everything for the zone
 *   npm run cf-purge -- --prefix dists/ --dry-run
 */

import {
    SSMClient,
    GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
    S3Client,
    ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { addErrorContext, getConfig, handleError } from "./preflight";

const PURGE_BATCH_SIZE = 30;

interface Args {
    prefix?: string;
    all:     boolean;
    dryRun:  boolean;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { all: false, dryRun: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--prefix")        args.prefix = argv[++i] ?? "";
        else if (a === "--all")      args.all    = true;
        else if (a === "--dry-run")  args.dryRun = true;
        else {
            process.stderr.write(`Unknown argument: ${a}\n`);
            usage();
            process.exit(1);
        }
    }
    if (!args.all && args.prefix === undefined) {
        usage();
        process.exit(1);
    }
    if (args.all && args.prefix !== undefined) {
        process.stderr.write("Error: --all and --prefix are mutually exclusive.\n");
        process.exit(1);
    }
    return args;
}

function usage(): void {
    process.stderr.write(
        "Usage:\n" +
        "  npm run cf-purge -- --prefix <path>      Purge all objects under <path>\n" +
        "  npm run cf-purge -- --prefix ''          Purge everything under repo prefix\n" +
        "  npm run cf-purge -- --all                Purge entire Cloudflare zone\n" +
        "  npm run cf-purge -- --prefix <path> --dry-run\n"
    );
}

function parseS3Uri(uri: string): { bucket: string; prefix: string } {
    const m = uri.match(/^s3:\/\/([^/]+)(?:\/(.*))?$/);
    if (!m) throw new Error(`Invalid S3 URI: ${uri}`);
    const bucket = m[1];
    const prefix = (m[2] ?? "").replace(/\/+$/, "");
    return { bucket, prefix };
}

function resolvePublicBaseUrl(): string {
    const explicit = getConfig("aptAwscliV2:cloudflarePublicBaseUrl");
    if (explicit) return explicit.replace(/\/+$/, "");
    const customDomain = getConfig("aptAwscliV2:cloudflareCustomDomain");
    if (customDomain) return `https://${customDomain}`;
    throw new Error(
        "Public base URL is not configured. Set either " +
        "aptAwscliV2:cloudflarePublicBaseUrl or aptAwscliV2:cloudflareCustomDomain.",
    );
}

async function loadApiToken(paramName: string): Promise<string> {
    const ssm = new SSMClient({});
    addErrorContext(ssm);
    const resp = await ssm.send(new GetParameterCommand({
        Name:           paramName,
        WithDecryption: true,
    }));
    const value = resp.Parameter?.Value;
    if (!value) throw new Error(`SSM parameter ${paramName} has no value`);
    const obj = JSON.parse(value) as { api_token?: string };
    if (!obj.api_token) throw new Error(`SSM parameter ${paramName} is missing api_token`);
    return obj.api_token;
}

async function listKeys(bucket: string, fullPrefix: string): Promise<string[]> {
    const s3 = new S3Client({});
    addErrorContext(s3);

    const keys: string[] = [];
    let token: string | undefined;
    do {
        const resp = await s3.send(new ListObjectsV2Command({
            Bucket:            bucket,
            Prefix:            fullPrefix || undefined,
            ContinuationToken: token,
        }));
        for (const obj of resp.Contents ?? []) {
            if (obj.Key) keys.push(obj.Key);
        }
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    return keys;
}

function keyToUrl(baseUrl: string, key: string, repoPrefix: string): string {
    const base = baseUrl.replace(/\/+$/, "");
    let relative = key;
    if (repoPrefix) {
        const p = `${repoPrefix.replace(/\/+$/, "")}/`;
        if (key.startsWith(p)) relative = key.slice(p.length);
    }
    return `${base}/${relative}`;
}

async function purge(
    apiToken: string,
    zoneId:   string,
    body:     Record<string, unknown>,
): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "authorization": `Bearer ${apiToken}`,
            "content-type":  "application/json",
        },
        body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) {
        throw new Error(`Cloudflare purge HTTP ${resp.status}: ${text}`);
    }
    let parsed: { success?: boolean };
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`Cloudflare purge returned non-JSON response: ${text}`);
    }
    if (!parsed.success) {
        throw new Error(`Cloudflare purge returned success=false: ${text}`);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv);

    const ssmParam = getConfig("aptAwscliV2:cloudflareSsmParam");
    if (!ssmParam) {
        throw new Error(
            "aptAwscliV2:cloudflareSsmParam is not set in Pulumi config.\n" +
            "  Run: pulumi config set aptAwscliV2:cloudflareSsmParam /apt-awscli-v2/cloudflare"
        );
    }
    const zoneId = getConfig("aptAwscliV2:cloudflareZoneId");
    if (!zoneId) {
        throw new Error("aptAwscliV2:cloudflareZoneId is not set in Pulumi config");
    }
    const s3Uri = getConfig("aptAwscliV2:s3Uri");
    if (!s3Uri) throw new Error("aptAwscliV2:s3Uri is not set in Pulumi config");
    const { bucket, prefix: repoPrefix } = parseS3Uri(s3Uri);
    const publicBaseUrl = resolvePublicBaseUrl();

    const apiToken = await loadApiToken(ssmParam);

    if (args.all) {
        console.log(`Purging entire Cloudflare zone (${zoneId})`);
        if (args.dryRun) {
            console.log(`[dry-run] would POST purge_everything: true`);
            return;
        }
        await purge(apiToken, zoneId, { purge_everything: true });
        console.log(`OK: zone ${zoneId} purged`);
        return;
    }

    const userPrefix = (args.prefix ?? "").replace(/^\/+/, "");
    const fullPrefix = repoPrefix
        ? (userPrefix ? `${repoPrefix}/${userPrefix}` : `${repoPrefix}/`)
        : userPrefix;

    console.log(`Listing s3://${bucket}/${fullPrefix} ...`);
    const keys = await listKeys(bucket, fullPrefix);
    if (keys.length === 0) {
        console.log("No objects found under that prefix; nothing to purge.");
        return;
    }
    const urls = Array.from(new Set(keys.map(k => keyToUrl(publicBaseUrl, k, repoPrefix)))).sort();
    console.log(`Found ${urls.length} URL(s) to purge.`);

    if (args.dryRun) {
        for (const u of urls) console.log(`[dry-run] ${u}`);
        return;
    }

    let failed = 0;
    for (let i = 0; i < urls.length; i += PURGE_BATCH_SIZE) {
        const batch  = urls.slice(i, i + PURGE_BATCH_SIZE);
        const batchN = Math.floor(i / PURGE_BATCH_SIZE) + 1;
        const total  = Math.ceil(urls.length / PURGE_BATCH_SIZE);
        try {
            await purge(apiToken, zoneId, { files: batch });
            console.log(`OK: batch ${batchN}/${total} (${batch.length} URLs)`);
        } catch (e) {
            failed++;
            const msg = e instanceof Error ? e.message : String(e);
            process.stderr.write(`FAIL: batch ${batchN}/${total}: ${msg}\n`);
        }
    }
    if (failed > 0) {
        process.stderr.write(`${failed} batch(es) failed.\n`);
        process.exit(1);
    }
    console.log(`Done. Purged ${urls.length} URL(s).`);
}

main().catch(handleError);
