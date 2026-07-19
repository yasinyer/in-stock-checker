# in-stock-checker

Checks product pages (Uniqlo, COS) for stock availability and sends a free
push notification (via [ntfy.sh](https://ntfy.sh)) as soon as a watched item
is back in stock.

## How it works

- `products.json` lists the products to watch, each with an `ntfyTopic` to
  publish a notification to.
- `src/check-stock.mjs` is the entrypoint that runs all checks:
  - **Uniqlo** entries (no `type` field) are checked via Uniqlo's internal
    commerce API for the product/color/size combination encoded in the URL's
    query string (`colorDisplayCode`, `sizeDisplayCode`, `pldDisplayCode`).
    Items flagged "coming soon" (not yet purchasable, even with warehouse
    stock) are treated as unavailable.
  - **COS** entries (`"type": "cos"`) are checked via `src/check-cos.mjs`
    using Playwright (headless Chromium), because COS.com sits behind Akamai
    bot protection. Every color variant listed in `colorVariants` is visited
    and the target size is available when its size chip does not show
    "Notify me".
- `state.json` remembers the availability from the last check, so a
  notification is only sent on the transition unavailable -> available
  (not on every run).
- `.github/workflows/check-stock.yml` runs the check every 15 minutes via
  GitHub Actions and commits the updated `state.json` back to the repo.

## Currently watched

- **COS Slim Ribbed Cotton Tank Top** — size S, in any color except
  black/grey/white (Navy, Khaki, Blue, Light Mole, Dark Mole, Beige Mélange,
  Dark Brown). Topic: `instock-checker-yasinyer-cb65fea64d4a`.

## Get notified

1. Install the [ntfy app](https://ntfy.sh/) (iOS/Android) or open
   `https://ntfy.sh/<topic>` in a browser.
2. Subscribe to the topic configured for your product in `products.json`.
3. That's it — no account or credentials needed. Anyone who knows the topic
   name can publish/subscribe to it, so it's not a private channel, but the
   random suffix makes it hard to guess.

## Add another product to watch

Add an entry to `products.json`. For Uniqlo:

```json
{
  "label": "Readable name for notifications",
  "url": "https://www.uniqlo.com/<region>/<locale>/products/<id>/<priceGroup>?colorDisplayCode=..&sizeDisplayCode=..",
  "ntfyTopic": "pick-your-own-random-topic-name"
}
```

For COS, use `"type": "cos"` with a `targetSize` and a `colorVariants` list
(see the existing entry in `products.json` as a template).

## Run locally

```bash
npm install
npx playwright install --with-deps chromium
npm run check
```

## Note on GitHub Actions schedules

GitHub only runs the `schedule` trigger for workflows that live on the
repository's default branch. Changes take effect once merged into `main`;
you can also trigger a run manually from the Actions tab
(`workflow_dispatch`).
