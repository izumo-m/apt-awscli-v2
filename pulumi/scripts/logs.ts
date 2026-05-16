/**
 * logs.ts
 *
 * Usage:
 *   npm run logs                   # Show logs from the past 10 minutes and exit
 *   npm run logs -- --follow       # Continuous display via polling
 *   npm run logs -- --since 30     # Show logs from the past 30 minutes
 */

import {
    CloudWatchLogsClient,
    FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { getLambdaName, handleError, addErrorContext } from "./preflight";

// ─── CLI Argument Parsing ────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const follow = args.includes("--follow");

let sinceMins = 10;
const sinceIdx = args.indexOf("--since");
if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    const raw    = args[sinceIdx + 1];
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed <= 0) {
        process.stderr.write(`Error: --since must be a positive integer (minutes), got "${raw}".\n`);
        process.exit(1);
    }
    sinceMins = parsed;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const lambdaName  = getLambdaName();
const logGroupName = `/aws/lambda/${lambdaName}`;
const client       = new CloudWatchLogsClient({});
addErrorContext(client);

const POLL_INTERVAL_MS = 2000;

function formatTimestamp(ms: number): string {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `[${hh}:${mm}:${ss}]`;
}

async function fetchLogs(startTime: number, nextToken?: string): Promise<{ nextStartTime: number; nextToken?: string }> {
    const resp = await client.send(new FilterLogEventsCommand({
        logGroupName,
        startTime,
        nextToken,
        interleaved: true,
    }));

    let maxTs = startTime;
    for (const event of resp.events ?? []) {
        const ts = event.timestamp ?? startTime;
        const msg = (event.message ?? "").replace(/\n$/, "");
        process.stdout.write(`${formatTimestamp(ts)} ${msg}\n`);
        if (ts > maxTs) maxTs = ts;
    }

    return {
        nextStartTime: maxTs + 1,
        nextToken:     resp.nextToken,
    };
}

(async () => {
    let startTime = Date.now() - sinceMins * 60 * 1000;

    if (!follow) {
        // Fetch all pages and exit
        let token: string | undefined;
        do {
            const result = await fetchLogs(startTime, token);
            startTime = result.nextStartTime;
            token     = result.nextToken;
        } while (token);
        return;
    }

    // --follow: polling mode
    console.error(`Tailing ${logGroupName} (Ctrl+C to stop)`);
    while (true) {
        const result = await fetchLogs(startTime);
        startTime = result.nextStartTime;
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
})().catch(handleError);
