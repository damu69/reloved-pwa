import { expect, test } from "@playwright/test";
import { freshClient, watchErrors } from "./helpers";

test.beforeEach(async ({ context }) => freshClient(context));

test("home page loads and shows the seeded items with no browser errors", async ({ page }) => {
  const problems = watchErrors(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "E2E Denim Jacket" }).first()).toBeVisible();
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the API is reachable through the site and reports healthy", async ({ request }) => {
  const r = await request.get("/api/v1/catalogue/gst-rates");
  expect(r.status()).toBeLessThan(500);
});

test("security headers are sent on pages", async ({ request }) => {
  const r = await request.get("/");
  const h = r.headers();
  expect(h["content-security-policy"]).toContain("default-src 'self'");
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["strict-transport-security"]).toContain("max-age=");
  expect(h["cross-origin-opener-policy"]).toBe("same-origin");
});

test("API source folders are not served", async ({ request }) => {
  for (const p of ["/server/package.json", "/server/.env", "/.git/config", "/e2e/seed.mjs", "/ci/jenkins/Dockerfile"]) {
    expect((await request.get(p)).status(), p).toBe(404);
  }
});

test("debug endpoints are closed", async ({ request }) => {
  for (const p of ["/api/v1/debug/client-ip", "/debug/client-ip"]) {
    expect((await request.get(p)).status(), p).toBe(404);
  }
});

test("legal and account-deletion pages exist", async ({ page }) => {
  for (const [url, text] of [["/privacy.html", /privacy/i], ["/terms.html", /terms/i], ["/delete-account.html", /delete/i]] as const) {
    const res = await page.goto(url);
    expect(res?.status(), url).toBe(200);
    await expect(page.locator("body")).toContainText(text);
  }
});

test("an unknown API route returns the standard error shape", async ({ request }) => {
  const r = await request.get("/api/v1/does-not-exist");
  expect(r.status()).toBe(404);
  expect((await r.json()).error.code).toBe("NOT_FOUND");
});
