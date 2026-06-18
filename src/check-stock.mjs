import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PRODUCTS_FILE = path.join(ROOT, "products.json");
const STATE_FILE = path.join(ROOT, "state.json");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Flags on a variant that mean it can't actually be bought yet, even if the
// warehouse already shows stock (e.g. a "coming soon" pre-order window).
const BLOCKING_FLAG_CODES = new Set(["comingSoon"]);
const AVAILABLE_STATUS_CODES = new Set(["IN_STOCK", "LOW_STOCK"]);

function parseProductUrl(rawUrl) {
  const url = new URL(rawUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  const productsIndex = segments.indexOf("products");
  if (productsIndex === -1 || segments.length < productsIndex + 3) {
    throw new Error(`Could not parse Uniqlo product URL: ${rawUrl}`);
  }

  const region = segments[productsIndex - 2];
  const locale = segments[productsIndex - 1];
  const productId = segments[productsIndex + 1];
  const priceGroup = segments[productsIndex + 2];

  return {
    region,
    locale,
    productId,
    priceGroup,
    colorDisplayCode: url.searchParams.get("colorDisplayCode"),
    sizeDisplayCode: url.searchParams.get("sizeDisplayCode"),
    pldDisplayCode: url.searchParams.get("pldDisplayCode"),
  };
}

async function fetchL2sAndStocks({ region, locale, productId, priceGroup }) {
  const apiUrl =
    `https://www.uniqlo.com/${region}/api/commerce/v5/${locale}/products/${productId}` +
    `/price-groups/${priceGroup}/l2s?withPrices=true&withStocks=true&httpFailure=true`;

  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "x-fr-clientid": `uq.${region}.web-spa`,
      Referer: `https://www.uniqlo.com/${region}/${locale}/products/${productId}/${priceGroup}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Uniqlo API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (data.status !== "ok") {
    throw new Error(`Uniqlo API returned an error: ${JSON.stringify(data)}`);
  }

  return data.result;
}

function findVariant(result, { colorDisplayCode, sizeDisplayCode, pldDisplayCode }) {
  return result.l2s.find((l2) => {
    if (colorDisplayCode && l2.color?.displayCode !== colorDisplayCode) return false;
    if (sizeDisplayCode && l2.size?.displayCode !== sizeDisplayCode) return false;
    if (pldDisplayCode && l2.pld?.displayCode !== pldDisplayCode) return false;
    return true;
  });
}

function isAvailable(variant, result) {
  if (!variant) return false;

  const blockingFlag = variant.flags?.productFlags?.find((flag) =>
    BLOCKING_FLAG_CODES.has(flag.code),
  );
  if (blockingFlag) return false;

  const stock = result.stocks?.[variant.l2Id];
  if (!stock) return false;

  return AVAILABLE_STATUS_CODES.has(stock.statusCode) && stock.quantity > 0;
}

async function notify(topic, { title, message, url }) {
  await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: {
      Title: title,
      Tags: "package,bell",
      Click: url,
    },
    body: message,
  });
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function main() {
  const products = await loadJson(PRODUCTS_FILE, []);
  const state = await loadJson(STATE_FILE, {});

  for (const product of products) {
    const key = product.url;
    try {
      const params = parseProductUrl(product.url);
      const result = await fetchL2sAndStocks(params);
      const variant = findVariant(result, params);
      const available = isAvailable(variant, result);
      const wasAvailable = state[key]?.available ?? false;

      console.log(`[${product.label ?? product.url}] available=${available}`);

      if (available && !wasAvailable) {
        await notify(product.ntfyTopic, {
          title: "Weer op voorraad!",
          message: `${product.label ?? "Product"} is weer op voorraad bij Uniqlo.`,
          url: product.url,
        });
        console.log(`  -> notification sent to ntfy.sh/${product.ntfyTopic}`);
      }

      state[key] = { available, checkedAt: new Date().toISOString() };
    } catch (error) {
      console.error(`[${product.label ?? product.url}] check failed:`, error.message);
    }
  }

  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

main();
