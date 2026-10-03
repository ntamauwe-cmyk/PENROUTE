/**
 * In-browser assertion of the landing-page greeting.
 *
 * Usage (from the project root, with the dev server running):
 *   node scripts/verify-greeting.mjs
 *
 * Optional custom URL:
 *   APP_URL=https://your-preview.example node scripts/verify-greeting.mjs
 *
 * Exits 0 when the rendered greeting matches the local clock, 1 otherwise.
 */
import { chromium } from "playwright";

const BASE = process.env.APP_URL || "http://localhost:5173";

const expectedFor = (hour) =>
  hour >= 5 && hour < 12
    ? "Good morning"
    : hour >= 12 && hour < 17
      ? "Good afternoon"
      : "Good evening";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(BASE + "/", { waitUntil: "load", timeout: 20000 });
  const el = page.getByText(/Good (morning|afternoon|evening), Employer/).first();
  await el.waitFor({ timeout: 10000 });
  const text = await el.textContent();
  const hour = new Date().getHours();
  const expected = `${expectedFor(hour)}, Employer`;
  const pass = text === expected;
  console.log(`page:       ${BASE}/`);
  console.log(`rendered:   ${text}`);
  console.log(`local hour: ${hour}:00 -> expected "${expected}"`);
  console.log(pass ? "RESULT: GREETING_OK" : `RESULT: GREETING_WRONG (expected "${expected}")`);
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.error("RESULT: CHECK_FAILED —", err.message);
  console.error("Is the dev server running? Start it with:  bun run dev");
  process.exit(1);
} finally {
  await browser.close();
}
