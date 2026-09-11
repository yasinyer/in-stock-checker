/**
 * H&M stock checker.
 *
 * www2.hm.com sits behind the same Akamai bot protection as COS and serves
 * this checker an "Access Denied" page. api.hm.com does not: its search
 * service answers happily, and querying it with a full article id returns
 * exactly that one product, sizes and per-size stock included. So this needs
 * no browser — unlike the COS checker, and unlike scraping the product page.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Picks the requested sizes out of a product and reports which are in stock.
 *
 * Deliberately ignores the product-level `availability.stockState`. That field
 * reads "Available" while the size you want sits at stock 0 — it describes the
 * garment, not the size, and trusting it would mean announcing a restock that
 * cannot be bought.
 *
 * Kept separate from the fetch so it can be tested without the network.
 */
export function selectSizes(product, wantedNames) {
  const sizes = product?.sizes;
  if (!Array.isArray(sizes) || sizes.length === 0) {
    throw new Error("product carried no sizes");
  }

  const byLabel = new Map(sizes.map((s) => [String(s.label).toUpperCase(), s]));

  return wantedNames.map((name) => {
    const size = byLabel.get(name.toUpperCase());
    if (!size) {
      throw new Error(
        `size ${name} not offered — available: ${[...byLabel.keys()].join(", ")}`,
      );
    }
    return {
      name: name.toUpperCase(),
      stock: size.stock,
      available: Number(size.stock) > 0,
    };
  });
}

async function fetchProduct({ locale, articleId }) {
  const url =
    `https://api.hm.com/search-services/v1/${locale}/search/resultpage` +
    `?query=${encodeURIComponent(articleId)}&touchPoint=DESKTOP&page=1&pageSize=10`;

  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`H&M request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const hits = data?.searchHits?.productList;
  if (!Array.isArray(hits)) {
    throw new Error("H&M response had no product list");
  }

  // Match the exact article rather than taking the first hit: the query is a
  // search, and a near miss would silently watch a different colour.
  const product = hits.find((p) => String(p.id) === String(articleId));
  if (!product) {
    throw new Error(
      `article ${articleId} not in results — got: ${hits.map((p) => p.id).join(", ") || "nothing"}`,
    );
  }

  return product;
}

/**
 * Checks a H&M product and returns the names of the requested sizes that are
 * currently in stock.
 */
export async function checkHmProduct(product) {
  const found = await fetchProduct({
    locale: product.locale ?? "nl_BE",
    articleId: product.articleId,
  });

  const results = selectSizes(found, product.sizes);
  for (const { name, stock, available } of results) {
    console.log(
      `  [H&M] ${name} → ${available ? "IN STOCK" : "out of stock"} (stock ${stock})`,
    );
  }

  return {
    productName: found.productName,
    colorName: found.colorName,
    available: results.filter((r) => r.available).map((r) => r.name),
  };
}
