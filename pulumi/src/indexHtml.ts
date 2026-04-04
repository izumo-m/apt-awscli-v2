/**
 * Generate index.html from the top-level README.md.
 *
 * Called from preview.ts / up.ts before pulumi commands so that the
 * generated file is available for BucketObjectv2 during the plan phase.
 * The output is written to pulumi.out/index.html for easy local preview.
 */

import * as fs from "fs";
import * as path from "path";

const README_PATH    = path.resolve(__dirname, "..", "..", "README.md");
const INDEX_HTML_DIR = path.resolve(__dirname, "..", "pulumi.out");

/** Convert README.md to a styled HTML page and write to pulumi.out/index.html. */
export function generateIndexHtml(): void {
    // marked v17+ is ESM-only; Node.js 22+ supports require() for ESM modules
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { marked } = require("marked") as { marked: { parse(src: string, options?: { async: false }): string } };
    const markdown = fs.readFileSync(README_PATH, "utf8");
    const bodyHtml = marked.parse(markdown, { async: false }) as string;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>apt-awscli-v2</title>
<style>
body {
    max-width: 48rem;
    margin: 2rem auto;
    padding: 0 1rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #24292f;
}
pre {
    background: #f6f8fa;
    padding: 1rem;
    border-radius: 6px;
    overflow-x: auto;
}
code {
    background: #f6f8fa;
    padding: 0.2em 0.4em;
    border-radius: 3px;
    font-size: 0.9em;
}
pre code {
    background: none;
    padding: 0;
}
a {
    color: #0969da;
}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;

    fs.mkdirSync(INDEX_HTML_DIR, { recursive: true });
    fs.writeFileSync(path.join(INDEX_HTML_DIR, "index.html"), html);
}
