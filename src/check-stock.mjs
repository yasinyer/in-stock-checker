import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkCosProduct } from "./check-cos.mjs";

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

// ── Uniqlo helpers ────────────────────────────────────────────────────────────

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

function isUniqloAvailable(variant, result) {
  if (!variant) return false;

  const blockingFlag = variant.flags?.productFlags?.find((flag) =>
    BLOCKING_FLAG_CODES.has(flag.code),
  );
  if (blockingFlag) return false;

  const stock = result.stocks?.[variant.l2Id];
  if (!stock) return false;

  return AVAILABLE_STATUS_CODES.has(stock.statusCode) && stock.quantity > 0;
}

// ── Shared notification helper ────────────────────────────────────────────────

/**
 * Resolves the ntfy topic for a product from the environment.
 *
 * The topic is a shared secret — anyone who knows it can read your
 * notifications and publish fake ones — so it is never committed to this
 * repository. It comes from the NTFY_TOPIC environment variable (a GitHub
 * Actions secret in CI), or from the variable named by the product's
 * optional `ntfyTopicEnv` field.
 */
function resolveTopic(product) {
  const varName = product.ntfyTopicEnv ?? "NTFY_TOPIC";
  const topic = process.env[varName];
  if (!topic) {
    throw new Error(
      `${varName} is not set — cannot send notifications. ` +
        `Set it as a GitHub Actions secret (or export it locally).`,
    );
  }
  return topic;
}

async function notify(topic, { title, message, url }) {
  // Publish via ntfy's JSON format rather than its X-Title/X-Click headers.
  // HTTP header values are ByteStrings, so any character above U+00FF throws
  // before the request is even sent — an en dash in a title was enough to
  // break the notification. JSON carries the fields as UTF-8 instead.
  const response = await fetch("https://ntfy.sh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      title,
      message,
      tags: ["package", "bell"],
      click: url,
    }),
  });

  // A dropped notification is the one failure that must never pass quietly:
  // it is the whole point of the checker.
  if (!response.ok) {
    throw new Error(`ntfy.sh returned ${response.status} ${response.statusText}`);
  }
}

// ── File helpers ──────────────────────────────────────────────────────────────

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

// ── Test mode ─────────────────────────────────────────────────────────────────

/**
 * Sends one notification per configured topic and checks nothing.
 *
 * This proves the whole chain in one run — the NTFY_TOPIC secret, ntfy.sh,
 * and the subscription on your phone — without waiting for a real restock.
 * Reading the secret back is impossible, so this is the only way to confirm
 * it holds the topic you are actually subscribed to.
 */
async function sendTestNotifications(products) {
  if (products.length === 0) {
    throw new Error("no products configured — nothing to send a test to");
  }

  // Several products may share one topic; only send once per topic.
  const topics = new Set(products.map(resolveTopic));

  for (const topic of topics) {
    await notify(topic, {
      title: "Test — in-stock-checker",
      message:
        "Deze testmelding komt uit de GitHub Action en gebruikt het " +
        "NTFY_TOPIC secret. Zie je dit, dan werkt de hele keten.",
      url: "https://github.com/yasinyer/in-stock-checker/actions",
    });
    console.log("  -> test notification sent");
  }

  console.log(`Sent ${topics.size} test notification(s).`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const testMode = process.argv.includes("--test-notification");
  const products = await loadJson(PRODUCTS_FILE, []);
  const state = await loadJson(STATE_FILE, {});
  let failed = 0;

  // Check every topic up front. Otherwise a missing secret only surfaces at
  // the moment a restock is found — exactly when the notification matters.
  for (const product of products) {
    resolveTopic(product);
  }

  if (testMode) {
    await sendTestNotifications(products);
    return;
  }

  for (const product of products) {
    const ok =
      product.type === "cos"
        ? await handleCosProduct(product, state)
        : await handleUniqloProduct(product, state);
    if (!ok) failed++;
  }

  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

  // Exit non-zero so a broken checker shows up as a failed Actions run.
  // Silently "succeeding" while checking nothing means a restock would pass
  // by unnoticed.
  if (failed > 0) {
    console.error(`${failed} of ${products.length} product checks failed`);
    process.exitCode = 1;
  }
}

async function handleUniqloProduct(product, state) {
  const key = product.url;
  try {
    const params = parseProductUrl(product.url);
    const result = await fetchL2sAndStocks(params);
    const variant = findVariant(result, params);
    const available = isUniqloAvailable(variant, result);
    const wasAvailable = state[key]?.available ?? false;

    console.log(`[${product.label ?? product.url}] available=${available}`);

    if (available && !wasAvailable) {
      await notify(resolveTopic(product), {
        title: "Weer op voorraad!",
        message: `${product.label ?? "Product"} is weer op voorraad bij Uniqlo.`,
        url: product.url,
      });
      // Don't log the topic itself — CI logs are public on a public repo.
      console.log("  -> notification sent");
    }

    state[key] = { available, checkedAt: new Date().toISOString() };
    return true;
  } catch (error) {
    console.error(`[${product.label ?? product.url}] check failed:`, error.message);
    return false;
  }
}

async function handleCosProduct(product, state) {
  const key = `cos:${product.label}`;
  console.log(`[${product.label}] checking ${product.colorVariants.length} color variants…`);

  try {
    const availableNow = await checkCosProduct(product);
    const availableNames = availableNow.map((v) => v.name);
    const prevAvailableNames = state[key]?.availableColors ?? [];

    // Newly in stock = available now but NOT in the previous state.
    const newlyAvailable = availableNow.filter(
      (v) => !prevAvailableNames.includes(v.name),
    );

    if (newlyAvailable.length > 0) {
      const colorList = newlyAvailable.map((v) => v.name).join(", ");
      await notify(resolveTopic(product), {
        title: "COS – Weer op voorraad!",
        message:
          `${product.label} — nu beschikbaar in: ${colorList}. ` +
          `Maat: ${product.targetSize}.`,
        url: newlyAvailable[0].url,
      });
      console.log(`  -> notification sent for: ${colorList}`);
    }

    state[key] = {
      availableColors: availableNames,
      checkedAt: new Date().toISOString(),
    };
    return true;
  } catch (error) {
    console.error(`[${product.label}] COS check failed:`, error.message);
    return false;
  }
}

main();
