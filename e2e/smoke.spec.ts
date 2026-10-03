import { test, expect, type Page } from "@playwright/test";

/**
 * Penroute browser smoke suite.
 *
 * Covers the checks that static analysis cannot: the React app actually
 * mounts, routes resolve, RequireAuth redirects signed-out visitors, and no
 * uncaught exceptions (blank-screen crashes) occur. Uses only public routes
 * so no test data is written to the backend.
 */

/** Collect uncaught page errors (the "blank preview" culprits). */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

test("landing page mounts with hero and CTAs", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page).toHaveTitle(/Penroute/i);
  // A visible <h1> proves React mounted (no blank screen).
  await expect(page.locator("h1").first()).toBeVisible();
  // Primary CTA ("Get Started") enters the auth flow for signed-out visitors.
  const getStarted = page.getByRole("button", { name: "Get Started" }).first();
  await expect(getStarted).toBeVisible();
  await expect(page.getByRole("button", { name: "Log In" })).toBeVisible();
  await getStarted.click();
  await page.waitForURL(/\/auth/);
  await expect(page.locator('input[type="email"]')).toBeVisible();
  expect(errors, `uncaught errors on /\n${errors.join("\n")}`).toEqual([]);
});

test("auth page renders the sign-in form", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/auth");
  await expect(page.locator('input[type="email"]')).toBeVisible();
  expect(errors, `uncaught errors on /auth\n${errors.join("\n")}`).toEqual([]);
});

test("signed-out visit to /dashboard redirects to /auth with returnTo", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/dashboard");
  await page.waitForURL(/\/auth\?returnTo=%2Fdashboard/);
  await expect(page.locator('input[type="email"]')).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("primary product routes exist (redirect to auth, not 404)", async ({ page }) => {
  const routes = [
    "/dashboard/billing",
    "/admin/pricing",
    "/admin/revenue",
    "/dashboard/reconciliation",
    "/dashboard/statements",
    "/pfa",
  ];
  for (const route of routes) {
    const errors = trackErrors(page);
    await page.goto(route);
    await page.waitForURL(/\/auth\?returnTo=/);
    expect(errors, `uncaught errors on ${route}\n${errors.join("\n")}`).toEqual([]);
  }
});

test("unknown route renders the 404 page", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/definitely-not-a-real-page");
  await expect(page.getByText("Page Not Found")).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("landing page is responsive at mobile width", async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("h1").first()).toBeVisible();
  // No horizontal overflow at phone width.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(2);
  expect(errors, errors.join("\n")).toEqual([]);
});
