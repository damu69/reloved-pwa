import { expect, test } from "@playwright/test";
import { freshClient, register, uniqueEmail, watchErrors } from "./helpers";

test.beforeEach(async ({ context }) => freshClient(context));

test("search finds an item and tolerates a small typo", async ({ page }) => {
  await page.goto("/search?q=denim");
  await expect(page.getByRole("link", { name: "E2E Denim Jacket" }).first()).toBeVisible();
  await page.goto("/search?q=denimm");
  await expect(page.getByRole("link", { name: "E2E Denim Jacket" }).first()).toBeVisible();
});

test("search with no match shows an empty result, not an error", async ({ page }) => {
  const problems = watchErrors(page);
  await page.goto("/search?q=zzzzqqqq");
  await expect(page.getByRole("link", { name: /E2E/ })).toHaveCount(0);
  expect(problems, problems.join("\n")).toEqual([]);
});

test("a visitor must sign in before adding to the cart", async ({ page }) => {
  await page.goto("/search?q=scarf");
  await page.getByRole("link", { name: "E2E Silk Scarf" }).first().click();
  await page.locator('[data-a="addcart"]').first().click();
  await expect(page.locator("#af")).toBeVisible();
});

test("a signed-in buyer adds an item, sees the priced cart and reaches checkout", async ({ page }) => {
  const problems = watchErrors(page);
  await register(page, uniqueEmail("buyer"));
  await expect(page.getByText(/my orders|settings/i).first()).toBeVisible();
  await page.goto("/search?q=jacket");
  await page.getByRole("link", { name: "E2E Denim Jacket" }).first().click();
  await page.locator('[data-a="addcart"]').first().click();
  await page.goto("/cart");
  await expect(page.getByText("E2E Denim Jacket")).toBeVisible();
  await expect(page.locator("body")).toContainText("₹");
  await page.locator('[data-a="checkout"]').click();
  await expect(page.getByRole("heading", { name: /checkout/i }).first()).toBeVisible();
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the last piece cannot be added twice", async ({ page }) => {
  await register(page, uniqueEmail("last"));
  await expect(page.getByText(/my orders|settings/i).first()).toBeVisible();
  await page.goto("/search?q=kurta");
  await page.getByRole("link", { name: "E2E Last Piece Kurta" }).first().click();
  await page.locator('[data-a="addcart"]').first().click();
  await page.goto("/cart");
  await expect(page.getByText("E2E Last Piece Kurta")).toBeVisible();
  // The quantity "+" must not exceed stock; the cart stays at 1.
  const plus = page.locator('[data-a="cartqty"][data-j="1"]').first();
  await plus.click();
  await expect(page.locator(".qty span").first()).toHaveText("1");
});
