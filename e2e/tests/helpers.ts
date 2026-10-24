import { expect, type Page, type BrowserContext } from "@playwright/test";

export const PASSWORD = "correct horse battery";
export const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.test`;

// Every test gets its own fake client address, so the API's per-IP limits (for example 5 sign-ups per 15 minutes) never mix tests up.
export async function freshClient(context: BrowserContext) {
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  await context.setExtraHTTPHeaders({ "x-test-ip": ip });
}

// Collects real problems seen in the browser. Failed font downloads are ignored (the sandbox may have no internet).
export function watchErrors(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() !== "error") return;
    // An anonymous visitor makes one silent "am I signed in?" request that is answered 401. That is expected.
    if (/status of 401/.test(t)) return;
    if (/ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION|TUNNEL|FAILED)|fonts\.(googleapis|gstatic)/i.test(t)) return;
    problems.push(`console: ${t}`);
  });
  return problems;
}

export async function openAuth(page: Page, mode: "login" | "register") {
  await page.goto("/profile");
  await page.getByRole("button", { name: /sign in or create account/i }).click();
  await expect(page.locator("#af")).toBeVisible();
  if (mode === "register") await page.getByRole("button", { name: /^create account$/i }).first().click();
}

export async function register(page: Page, email: string, name = "E2E Tester") {
  await openAuth(page, "register");
  await page.locator("#an").fill(name);
  await page.locator("#ae").fill(email);
  await page.locator("#ap").fill(PASSWORD);
  await page.locator("#af button[type=submit]").click();
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await openAuth(page, "login");
  await page.locator("#ae").fill(email);
  await page.locator("#ap").fill(password);
  await page.locator("#af button[type=submit]").click();
}

// Signs out through the screens (Profile, Settings, Sign out), then checks that a fresh visit to Profile shows the signed-out page.
export async function signOut(page: Page) {
  await page.goto("/profile");
  await page.getByRole("button", { name: /settings/i }).first().click();
  const loggedOut = page.waitForResponse((r) => r.url().includes("/auth/logout"));
  await page.locator('[data-a="signout"]').click();
  await loggedOut;
  await page.goto("/profile");
  await expect(page.getByRole("button", { name: /sign in or create account/i })).toBeVisible();
}
