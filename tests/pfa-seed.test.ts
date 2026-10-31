import { expect, test } from "vitest";
import { internal } from "../src/convex/_generated/api";
import { newBackend } from "./helpers";

test("re-seeding an existing deployment renames Access → AccessARM, adds Pensions Alliance, keeps admin contact edits", async () => {
  const t = newBackend();
  // Simulate the live deployment's earlier 19-PFA seed state.
  await t.mutation(internal.pfaDirectory.seedDirectory, {});
  await t.run(async (ctx) => {
    const all = await ctx.db.query("pfas").collect();
    for (const p of all) {
      if (p.slug === "pensions_alliance") await ctx.db.delete(p._id);
      if (p.slug === "access_pensions")
        await ctx.db.patch(p._id, { name: "Access Pensions Limited", legalName: "Access Pensions Limited", websiteUrl: undefined });
      if (p.slug === "fcmb_pensions") await ctx.db.patch(p._id, { supportPhone: "+234 ADMIN EDIT" });
    }
  });
  const res = await t.mutation(internal.pfaDirectory.seedDirectory, {});
  expect(res.total).toBe(20);
  expect(res.inserted).toBe(1);
  const rows = await t.run((ctx) => ctx.db.query("pfas").collect());
  expect(rows).toHaveLength(20);
  const access = rows.find((p) => p.slug === "access_pensions")!;
  expect(access.name).toBe("AccessARM Pension Managers Limited");
  expect(access.websiteUrl).toBe("https://accesspensions.ng");
  expect(rows.find((p) => p.slug === "fcmb_pensions")!.supportPhone).toBe("+234 ADMIN EDIT");
  expect(rows.every((p) => p.active && p.status === "ACTIVE")).toBe(true);
  // Idempotent: a third run changes nothing.
  const again = await t.mutation(internal.pfaDirectory.seedDirectory, {});
  expect(again.inserted + again.updated).toBe(0);
});
