/**
 * Generate pulumi.out/index.html from the top-level README.md.
 *
 * Usage:
 *   npm run generate-index-html
 */

import { generateIndexHtml } from "../src/indexHtml";

generateIndexHtml();
console.log("Generated pulumi.out/index.html");
