/**
 * COS.com stock checker using Playwright (headless Chromium).
 *
 * COS uses Akamai bot protection on their main website. A real browser via
 * Playwright provides the best chance of passing bot detection from GitHub
 * Actions runners. If runs start getting blocked, consider running this on a
 * home machine/Raspberry Pi instead.
 *
 * Availability is detected by looking for a size button that does NOT contain
 * "Notify me" — COS server-renders "Notify me" on each out-of-stock size.
 */

import { chromium } from "playwright";

/**
 * Returns true if the given size is available (purchasable) on the product page.
 * Assumes the caller has already navigated to the correct URL.
 */
async function isSizeAvailable(page, targetSize) {
  // Wait for size selector to appear (COS renders it as a list/button group).
  // We look for any element containing the target size text.
  try {
    await page.waitForSelector(`text="${targetSize}"`, { timeout: 10_000 });
  } catch {
    // Size selector never appeared — treat as unavailable/error.
    return false;
  }

  // Collect all interactive elements whose text starts with the target size.
  // An available size element contains ONLY the size label (e.g. "S").
  // An out-of-stock one also contains "Notify me".
  const result = await page.evaluate((size) => {
    const candidates = Array.from(
      document.querySelectorAll("button, [role='button'], li, label"),
    );
    for (const el of candidates) {
      const text = el.textContent?.trim() ?? "";
      // Exact match on size alone → available
      if (text === size) return true;
      // Size label immediately followed by other non-"Notify" text could be
      // a size + stock-count badge; treat as available.
      if (text.startsWith(size) && !text.toLowerCase().includes("notify")) {
        // Guard against accidental matches like "S" inside "XS"
        const rest = text.slice(size.length).trim();
        if (rest === "" || /^\d+$/.test(rest)) return true;
      }
    }
    return false;
  }, targetSize);

  return result;
}

/**
 * Checks all COS color variants for the target size and returns an array of
 * { name, url } for every variant that is currently in stock in that size.
 */
export async function checkCosProduct(product) {
  const { colorVariants, targetSize } = product;
  const available = [];
  let failures = 0;

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "nl-BE",
      // Needed when running behind a TLS-intercepting proxy (some CI environments).
      // Has no effect in standard GitHub Actions runners.
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.8",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
    });

    // Remove the webdriver flag so bot-detection scripts don't see it.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page = await context.newPage();

    for (const variant of colorVariants) {
      try {
        await page.goto(variant.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        const inStock = await isSizeAvailable(page, targetSize);
        console.log(`  [COS] ${variant.name} / ${targetSize} → ${inStock ? "IN STOCK" : "out of stock"}`);
        if (inStock) available.push(variant);
      } catch (err) {
        failures++;
        console.error(`  [COS] Failed to check ${variant.name}: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  // If every variant failed (network problem, bot block, site down) we can't
  // say anything about availability — throw so the caller keeps the previous
  // state instead of resetting it (which would cause duplicate notifications).
  if (failures === colorVariants.length) {
    throw new Error("all variant checks failed");
  }

  return available;
}
