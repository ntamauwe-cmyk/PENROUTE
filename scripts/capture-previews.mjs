/**
 * Capture headless screenshots of the public pages so the work can be
 * previewed even when the platform preview proxy is unavailable.
 * Run: node scripts/capture-previews.mjs   (requires the dev server on 5173)
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5173";
mkdirSync("docs/preview", { recursive: true });

const shots = [
  { url: "/", file: "docs/preview/landing.png", w: 1440, h: 900, full: true },
  { url: "/", file: "docs/preview/landing-mobile.png", w: 390, h: 844, full: false },
  { url: "/auth", file: "docs/preview/auth.png", w: 1440, h: 900, full: false },
  { url: "/definitely-not-a-page", file: "docs/preview/not-found.png", w: 1440, h: 900, full: false },
];

const browser = await chromium.launch();
let failed = 0;
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
  try {
    const res = await page.goto(BASE + s.url, { waitUntil: "load", timeout: 20000 });
    if (!res || !res.ok()) throw new Error(`HTTP ${res ? res.status() : "no response"}`);
    await page.waitForTimeout(1500); // fonts, hero animation, Convex first paint
    await page.screenshot({ path: s.file, fullPage: s.full });
    console.log("captured", s.file);
  } catch (err) {
    failed++;
    console.error("FAILED", s.file, err.message);
  } finally {
    await page.close();
  }
}
await browser.close();
console.log(failed === 0 ? "ALL SCREENSHOTS OK" : `SCREENSHOT FAILURES: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
