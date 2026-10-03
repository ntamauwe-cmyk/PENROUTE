import { defineConfig } from "@playwright/test";

/**
 * Penroute E2E smoke tests.
 * Uses the already-running dev preview (Freebuff keeps it up) — no webServer
 * is started here on purpose.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
