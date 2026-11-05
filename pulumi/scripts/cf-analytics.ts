/**
 * cf-analytics.ts
 *
 * Summarize the request analytics recorded by the Cloudflare Worker
 * (aptAwscliV2:cloudflareAnalyticsEnabled) using the Workers Analytics
 * Engine SQL API. The column layout is documented in cloudflare/index.js.
 *
 * Requires an API token with "Account → Account Analytics: Read" in
 * CLOUDFLARE_ANALYTICS_TOKEN (falls back to CLOUDFLARE_API_TOKEN).
 *
 * Usage:
 *   npm run cf-analytics                                  # last 30 days
 *   npm run cf-analytics -- --days 7
 *   npm run cf-analytics -- --exclude 203.0.113.0/24      # ignore a network (repeatable)
 *   npm run cf-analytics -- --sql "SELECT blob2, count() AS n FROM {dataset} GROUP BY blob2"
 */

import { resolveAnalyticsDataset } from "../src/config";
import { getConfig, handleError } from "./preflight";

// Analytics Engine keeps data for three months.
const MAX_DAYS = 92;

interface Args {
    days:    number;
    exclude: string[];
    sql?:    string;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { days: 30, exclude: [] };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--days")          args.days = Number(argv[++i]);
        else if (a === "--exclude")  args.exclude.push(argv[++i] ?? "");
        else if (a === "--sql")      args.sql = argv[++i] ?? "";
        else {
            process.stderr.write(`Unknown argument: ${a}\n`);
            usage();
            process.exit(1);
        }
    }
    if (!Number.isInteger(args.days) || args.days < 1 || args.days > MAX_DAYS) {
        process.stderr.write(`Error: --days must be an integer between 1 and ${MAX_DAYS}.\n`);
        process.exit(1);
    }
    for (const net of args.exclude) {
        // Values are interpolated into SQL, so only allow address characters.
        if (!/^[0-9A-Fa-f:.\/]+$/.test(net)) {
            process.stderr.write(`Error: invalid --exclude value: ${JSON.stringify(net)}\n`);
            process.exit(1);
        }
    }
    return args;
}

function usage(): void {
    process.stderr.write(
        "Usage:\n" +
        "  npm run cf-analytics [-- --days N] [--exclude <network>]...\n" +
        "  npm run cf-analytics -- --sql \"<query using {dataset}>\"\n" +
        "\n" +
        "Networks are stored as IPv4 /24 or IPv6 /48 (e.g. 203.0.113.0/24, 2001:db8:1::/48).\n"
    );
}

/** Dataset name for the current stack; throws when the add-on is disabled. */
function getDataset(): string {
    const enabled = getConfig("aptAwscliV2:cloudflareEnabled") === "true"
        && getConfig("aptAwscliV2:cloudflareAnalyticsEnabled") === "true";
    if (!enabled) {
        throw new Error(
            "Request analytics is not enabled for this stack. Set aptAwscliV2:cloudflareEnabled " +
            "and aptAwscliV2:cloudflareAnalyticsEnabled to true and run pulumi up.",
        );
    }
    const prefix = getConfig("aptAwscliV2:resourcePrefix") || "apt-awscli-v2";
    return resolveAnalyticsDataset(getConfig("aptAwscliV2:cloudflareAnalyticsDataset"), prefix);
}

type Row = Record<string, unknown>;

async function query(accountId: string, token: string, sql: string): Promise<Row[]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
    const resp = await fetch(url, {
        method:  "POST",
        headers: { "authorization": `Bearer ${token}` },
        body:    sql,
    });
    const text = await resp.text();
    if (!resp.ok) {
        throw new Error(`Analytics Engine SQL HTTP ${resp.status}: ${text}`);
    }
    let parsed: { data?: Row[] };
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`Analytics Engine SQL returned non-JSON response: ${text}`);
    }
    if (!Array.isArray(parsed.data)) {
        throw new Error(`Analytics Engine SQL returned no data: ${text}`);
    }
    return parsed.data;
}

function printTable(title: string, rows: Row[]): void {
    console.log(`\n== ${title}`);
    if (rows.length === 0) {
        console.log("(no data)");
        return;
    }
    const cols   = Object.keys(rows[0]);
    const cells  = rows.map(r => cols.map(c => String(r[c] ?? "")));
    const widths = cols.map((c, i) => Math.max(c.length, ...cells.map(r => r[i].length)));
    const line   = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
    console.log(line(cols));
    console.log(line(widths.map(w => "-".repeat(w))));
    for (const r of cells) console.log(line(r));
}

function reports(dataset: string, args: Args): { title: string; sql: string }[] {
    const where = [
        `timestamp > NOW() - INTERVAL '${args.days}' DAY`,
        ...(args.exclude.length > 0
            ? [`index1 NOT IN (${args.exclude.map(n => `'${n}'`).join(", ")})`]
            : []),
    ].join(" AND ");
    // blob6 (APT version) is non-empty only for requests sent by APT.
    const apt = `${where} AND blob6 != ''`;

    return [
        {
            title: "Requests by kind (all clients)",
            sql: `SELECT blob1 AS kind, SUM(_sample_interval) AS requests, COUNT(DISTINCT index1) AS networks
                  FROM ${dataset} WHERE ${where}
                  GROUP BY kind ORDER BY requests DESC`,
        },
        {
            title: "APT clients per day (UTC)",
            sql: `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
                         COUNT(DISTINCT index1) AS networks, SUM(_sample_interval) AS requests
                  FROM ${dataset} WHERE ${apt}
                  GROUP BY day ORDER BY day`,
        },
        {
            title: ".deb downloads (GET, HTTP 200)",
            sql: `SELECT blob3 AS package, blob5 AS arch,
                         SUM(_sample_interval) AS downloads, COUNT(DISTINCT index1) AS networks
                  FROM ${dataset} WHERE ${where} AND blob1 = 'deb' AND blob11 = 'GET' AND double1 = 200
                  GROUP BY package, arch ORDER BY downloads DESC`,
        },
        {
            title: "APT versions",
            sql: `SELECT blob6 AS apt_version, COUNT(DISTINCT index1) AS networks, SUM(_sample_interval) AS requests
                  FROM ${dataset} WHERE ${apt}
                  GROUP BY apt_version ORDER BY networks DESC`,
        },
        {
            title: "APT client networks (top 50)",
            sql: `SELECT index1 AS network, blob8 AS country, blob10 AS as_org,
                         SUM(_sample_interval) AS requests, MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen
                  FROM ${dataset} WHERE ${apt}
                  GROUP BY network, country, as_org ORDER BY requests DESC LIMIT 50`,
        },
    ];
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv);

    const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
    if (!token) {
        throw new Error(
            "Set CLOUDFLARE_ANALYTICS_TOKEN (or CLOUDFLARE_API_TOKEN) to a token with " +
            "Account Analytics: Read permission",
        );
    }
    const accountId = getConfig("aptAwscliV2:cloudflareAccountId");
    if (!accountId) throw new Error("aptAwscliV2:cloudflareAccountId is not set in Pulumi config");
    const dataset = getDataset();

    if (args.sql !== undefined) {
        const rows = await query(accountId, token, args.sql.split("{dataset}").join(dataset));
        printTable("Result", rows);
        return;
    }

    console.log(`Dataset: ${dataset}, last ${args.days} day(s)` +
        (args.exclude.length > 0 ? `, excluding ${args.exclude.join(", ")}` : ""));
    for (const r of reports(dataset, args)) {
        printTable(r.title, await query(accountId, token, `${r.sql} FORMAT JSON`));
    }
}

main().catch(handleError);
