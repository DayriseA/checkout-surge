/**
 * Renders every page in headless Chromium against a running server and fails
 * on console errors or missing key content. Screenshots land in the scratch
 * dir given by SMOKE_SHOT_DIR (optional).
 *   BASE_URL=http://localhost:4173 node scripts/smoke.ts
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:4173";
const shotDir = process.env.SMOKE_SHOT_DIR;

const pages: Array<{ path: string; expect: string[] }> = [
  { path: "/", expect: ["Results bench", "Who caught what", "Severity distribution"] },
  { path: "/findings", expect: ["of 83 findings", "Expected sold-out"] },
  { path: "/clusters", expect: ["confidence", "Expected sold-out 409s counted as k6 HTTP failures"] },
  { path: "/models/opus-4.8", expect: ["Opus 4.8", "F25"] },
  { path: "/models/glm-5.2?tab=report", expect: ["Consolidated Findings", "Section 8"] },
  { path: "/comparisons", expect: ["211 entries", "Buy response contract and taxonomy"] },
  { path: "/agentic-testing", expect: ["7 post-fix exploratory findings", "survived claimed fixes", "self-audit blind spots"] },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });

const consoleErrors: string[] = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

let failures = 0;
for (const [index, { path, expect }] of pages.entries()) {
  await page.goto(base + path, { waitUntil: "networkidle" });
  const text = (await page.textContent("body")) ?? "";
  const missing = expect.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    failures += 1;
    console.error(`FAIL  ${path} — missing: ${missing.join(" | ")}`);
  } else {
    console.log(`  ok  ${path}`);
  }
  if (shotDir) {
    await page.screenshot({ path: `${shotDir}/${index}-${path.replace(/[^a-z0-9]+/gi, "_")}.png`, fullPage: false });
  }
}

if (consoleErrors.length > 0) {
  failures += 1;
  console.error("Console errors:\n" + consoleErrors.join("\n"));
}

await browser.close();
console.log(failures === 0 ? "\nSmoke passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
