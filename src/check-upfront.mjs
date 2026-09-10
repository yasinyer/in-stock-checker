/**
 * Upfront.nl discount checker.
 *
 * Upfront runs on Shopify, which exposes a product's variants at
 * `/products/<handle>.js` — including per-variant availability and prices in
 * cents. No bot protection, so a plain fetch is enough (no browser needed).
 *
 * Detecting "on sale" here needs two signals, not one. The obvious rule is
 * Shopify's own `compare_at_price > price`, and this shop does use it for
 * genuine sales. But it also leaves stale values behind: on the Whey Milkshake
 * every available flavour sits at price 3800 with compare_at 3600 — a
 * compare_at *below* the price, which is not a discount at all. 69 of the
 * store's 276 variants are inverted that way. So a real price cut that leaves
 * compare_at untouched can easily stay invisible to that rule alone, which is
 * why the recorded baseline below exists as a second signal.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Formats a Shopify price (integer cents) as a euro string. */
export function formatPrice(cents) {
  return `€${(cents / 100).toFixed(2)}`;
}

async function fetchVariants(productJsUrl) {
  const response = await fetch(productJsUrl, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(
      `Upfront request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  if (!Array.isArray(data.variants)) {
    throw new Error("Upfront response had no variants array");
  }

  return data.variants;
}

/**
 * Checks a product's variants for discounts.
 *
 * `baselines` maps variant id -> highest price (in cents) seen so far; it is
 * returned updated so the caller can persist it. A variant counts as
 * discounted when it is purchasable and either carries a real Shopify sale
 * flag or has dropped below its own recorded baseline.
 */
export async function checkUpfrontProduct(product, baselines = {}) {
  const variants = await fetchVariants(product.productJsUrl);
  const nextBaselines = { ...baselines };
  const discounted = [];

  for (const variant of variants) {
    const id = String(variant.id);
    const price = variant.price;
    const compareAt = variant.compare_at_price;
    const baseline = nextBaselines[id];

    // The baseline only ever rises, so a sale price never becomes the new
    // "normal" and silence the next sale.
    nextBaselines[id] = baseline === undefined ? price : Math.max(baseline, price);

    if (!variant.available) continue;

    const onSaleFlag = compareAt != null && compareAt > price;
    const belowBaseline = baseline !== undefined && price < baseline;
    if (!onSaleFlag && !belowBaseline) continue;

    // Prefer the shop's own "was" price when it is actually higher; fall back
    // to what we recorded the price as before.
    const was = onSaleFlag ? compareAt : baseline;

    discounted.push({
      name: variant.title,
      price,
      was,
      reason: onSaleFlag ? "sale flag" : "price drop",
    });

    console.log(
      `  [Upfront] ${variant.title}: ${formatPrice(price)} ` +
        `(was ${formatPrice(was)}, ${onSaleFlag ? "sale flag" : "price drop"})`,
    );
  }

  const availableCount = variants.filter((v) => v.available).length;
  if (discounted.length === 0) {
    console.log(
      `  [Upfront] no discount on any of the ${availableCount} available flavour(s)`,
    );
  }

  return { discounted, baselines: nextBaselines };
}
