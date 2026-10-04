import { test, expect, type Page } from "@playwright/test";

/**
 * Authenticated journey smoke tests (development preview only).
 *
 * Uses the dev-only "Explore the demo workspace" entry (Anonymous provider)
 * so no real mailbox or payment is involved. Server-side session/OTP/RBAC
 * behaviour is covered separately by scripts/test-auth-regression.mjs.
 * A fresh guest has no employer workspace, so the app correctly lands on the
 * onboarding screen — the demo-employer load behind it is admin-gated, which
 * these tests also exercise in the browser.
 */

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

/** Signed-out → /auth, then guest sign-in, landing on /dashboard. */
async function guestLogin(page: Page) {
  await page.goto("/dashboard");
  await page.waitForURL(/\/auth\?returnTo=%2Fdashboard/);
  await page.getByRole("button", { name: "Explore the demo workspace" }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
}

test("guest login reaches the authenticated workspace", async ({ page }) => {
  const errors = trackErrors(page);
  await guestLogin(page);
  await expect(page).toHaveURL(/\/dashboard/);
  // Authenticated content: the workspace onboarding screen renders.
  await expect(page.getByRole("heading", { name: "Welcome to Penroute" })).toBeVisible();
  // Session persists across a full page reload (not bounced back to /auth).
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: "Welcome to Penroute" })).toBeVisible();
  expect(errors, `uncaught errors after login\n${errors.join("\n")}`).toEqual([]);
});

test("authenticated product routes stay inside the app (no bounce to /auth)", async ({
  page,
}) => {
  const errors = trackErrors(page);
  await guestLogin(page);
  const routes = [
    "/dashboard/employees",
    "/dashboard/batches",
    "/dashboard/transactions",
    "/dashboard/statements",
    "/dashboard/billing",
    "/dashboard/settings",
    "/dashboard/audit",
  ];
  for (const route of routes) {
    await page.goto(route);
    await page.waitForLoadState("load");
    const url = page.url();
    expect(url, `${route} bounced to auth`).not.toContain("/auth");
    expect(url, `${route} left the dashboard`).toContain("/dashboard");
  }
  expect(errors, `uncaught errors on product routes\n${errors.join("\n")}`).toEqual([]);
});

test("guest session is blocked from loading demo data (admin-only gate)", async ({
  page,
}) => {
  const errors = trackErrors(page);
  await guestLogin(page);
  await page.getByRole("button", { name: "Load demo workspace" }).click();
  // Hardened behaviour: demo seeding/claiming is restricted to admins, and a
  // guest (no role) must be refused with the server's own message.
  await expect(page.getByText(/restricted to platform admins/i).first()).toBeVisible({
    timeout: 15000,
  });
  expect(errors, `uncaught errors on demo gate\n${errors.join("\n")}`).toEqual([]);
});
