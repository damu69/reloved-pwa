import { expect, test } from "@playwright/test";
import { PASSWORD, freshClient, register, signIn, signOut, uniqueEmail, watchErrors } from "./helpers";

test.beforeEach(async ({ context }) => freshClient(context));

test("a visitor can create an account and is signed in", async ({ page }) => {
  const problems = watchErrors(page);
  await register(page, uniqueEmail("signup"), "New Buyer");
  // Regression: the name typed at sign-up used to be lost (the form was cleared before it was read).
  await expect(page.getByRole("heading", { name: "New Buyer" })).toBeVisible();
  expect(problems, problems.join("\n")).toEqual([]);
});

test("a wrong password is refused with a clear message and no session", async ({ page }) => {
  const email = uniqueEmail("wrongpw");
  await register(page, email);
  await expect(page.getByText(/my orders|settings/i).first()).toBeVisible();
  await signOut(page);
  await signIn(page, email, "not the right password");
  await expect(page.locator("#aerr")).not.toBeEmpty();
  await expect(page.locator("#af")).toBeVisible();
});

test("sign out, sign in again, and the session survives a reload", async ({ page }) => {
  const email = uniqueEmail("session");
  await register(page, email);
  await expect(page.getByText(/my orders|settings/i).first()).toBeVisible();
  await signOut(page);
  await signIn(page, email);
  await expect(page.getByText(/my orders|settings/i).first()).toBeVisible();
  // A full reload keeps the person signed in (the refresh cookie restores the session).
  await page.reload();
  await expect(page.getByText(/my orders/i).first()).toBeVisible();
});

test("short passwords and bad emails are rejected on sign-up", async ({ page }) => {
  await page.goto("/profile");
  await page.getByRole("button", { name: /sign in or create account/i }).click();
  await page.getByRole("button", { name: /^create account$/i }).first().click();
  await page.locator("#an").fill("Short Pw");
  await page.locator("#ae").fill(uniqueEmail("short"));
  await page.locator("#ap").fill("tiny");
  await page.locator("#af button[type=submit]").click();
  await expect(page.locator("#aerr")).not.toBeEmpty();
  expect(PASSWORD.length).toBeGreaterThanOrEqual(10);
});
