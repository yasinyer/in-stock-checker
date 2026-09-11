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
 * Reads every size chip on the current product page.
 *
 * Returns `[{ label, soldOut }]`. A chip's full text is either just the size
 * ("S") when it is purchasable, or the size followed by "Notify me" when it
 * is not.
 *
 * Throws rather than returning an empty list when nothing matches. "No size
 * chips found" means the page did not render, was blocked, or COS changed
 * their markup — none of which are the same thing as "out of stock", and
 * reporting them as such would silently park the watch forever.
 */
export async function readSizeChips(page) {
  // Poll for the chips themselves rather than waiting on a selector first.
  // Waiting for a bare size like "S" would time out on a product where every
  // size is sold out, since each chip then reads "S Notify me" — and that is
  // the normal case for anything worth watching.
  const handle = await page
    .waitForFunction(
      () => {
        const SIZE_RE = /^(XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,3})\s*(notify me)?$/i;
        const normalize = (node) =>
          (node?.textContent ?? "").replace(/\s+/g, " ").trim();

        const candidates = [];
        for (const el of document.querySelectorAll(
          "button, [role='button'], li, label, a",
        )) {
          if (SIZE_RE.test(normalize(el))) candidates.push(el);
        }

        // Keep only the outermost candidates, so "<button>S Notify me</button>"
        // wins over a bare "<span>S</span>" nested inside it — otherwise the
        // sold-out marker gets dropped and the size reads as purchasable.
        const outermost = candidates.filter(
          (el) => !candidates.some((other) => other !== el && other.contains(el)),
        );

        const found = outermost.map((el) => {
          const match = normalize(el).match(SIZE_RE);
          return { label: match[1].toUpperCase(), soldOut: Boolean(match[2]) };
        });

        return found.length > 0 ? found : false;
      },
      { timeout: 10_000 },
    )
    .catch(() => null);

  if (!handle) {
    throw new Error("no size chips rendered — page blocked or COS markup changed");
  }

  const chips = await handle.jsonValue();

  // One label can appear more than once (desktop and mobile renders). Treat a
  // size as sold out if any of its chips says so.
  const byLabel = new Map();
  for (const chip of chips) {
    const existing = byLabel.get(chip.label);
    byLabel.set(chip.label, {
      label: chip.label,
      soldOut: existing ? existing.soldOut || chip.soldOut : chip.soldOut,
    });
  }

  return [...byLabel.values()];
}

/**
 * Returns true if `targetSize` is purchasable, and logs every size it saw so
 * the run's output shows what the page actually offered.
 */
async function isSizeAvailable(page, targetSize) {
  const chips = await readSizeChips(page);
  const summary = chips
    .map((c) => `${c.label}${c.soldOut ? "(x)" : "(ok)"}`)
    .join(" ");

  const target = chips.find((c) => c.label === targetSize.toUpperCase());
  if (!target) {
    throw new Error(
      `size ${targetSize} not offered here — page lists: ${summary}`,
    );
  }

  console.log(`      sizes: ${summary}`);
  return !target.soldOut;
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
