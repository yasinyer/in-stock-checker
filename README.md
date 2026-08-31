# in-stock-checker

Checks product pages (Uniqlo, COS) for stock availability and sends a free
push notification (via [ntfy.sh](https://ntfy.sh)) as soon as a watched item
is back in stock.

## How it works

- `products.json` lists the products to watch. It deliberately contains no
  ntfy topic — see [Notification topic](#notification-topic) below.
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
- `.github/workflows/check-stock.yml` runs the check once a day (07:00 UTC)
  via GitHub Actions and commits the updated `state.json` back to the repo.
  You can also trigger it on demand from the Actions tab.

## Currently watched

- **COS Slim Ribbed Cotton Tank Top** — size S, in any color except
  black/grey/white (Navy, Khaki, Blue, Light Mole, Dark Mole, Beige Mélange,
  Dark Brown).

## Notification topic

This repository is public, so the ntfy topic is **not** stored here. An ntfy
topic is a shared secret: anyone who knows the name can both read your
notifications and publish fake ones to you.

The topic comes from the `NTFY_TOPIC` environment variable:

- **In CI** it is supplied by the repository secret of the same name
  (Settings -> Secrets and variables -> Actions).
- **Locally**, export it before running:
  `NTFY_TOPIC=your-topic npm run check`

`check-stock.mjs` verifies the variable is set before doing any work, so a
missing secret fails the run immediately instead of at the moment a restock
is found. The topic is never printed to the logs.

To receive notifications, install the [ntfy app](https://ntfy.sh/)
(iOS/Android) or open `https://ntfy.sh/<topic>` in a browser, and subscribe
to that same topic. No account needed.

If a topic ever leaks, rotate it: pick a new random name, update the secret,
and resubscribe in the app. The old topic can simply be abandoned.

## Add another product to watch

Add an entry to `products.json`. For Uniqlo:

```json
{
  "label": "Readable name for notifications",
  "url": "https://www.uniqlo.com/<region>/<locale>/products/<id>/<priceGroup>?colorDisplayCode=..&sizeDisplayCode=.."
}
```

For COS, use `"type": "cos"` with a `targetSize` and a `colorVariants` list
(see the existing entry in `products.json` as a template).

All products share the `NTFY_TOPIC` topic. To send one product elsewhere,
give it an `"ntfyTopicEnv": "SOME_OTHER_VAR"` field and add that secret too.

## Run locally

```bash
npm install
npx playwright install --with-deps chromium
NTFY_TOPIC=your-topic npm run check
```

## Note on GitHub Actions schedules

GitHub only runs the `schedule` trigger for workflows that live on the
repository's default branch. Changes take effect once merged into `main`;
you can also trigger a run manually from the Actions tab
(`workflow_dispatch`).

## Actions minutes

This repository is public, so Actions minutes are free and unmetered. It was
private until 2026-08-18, when the metered quota ran out and every scheduled
run started failing after 2-3 seconds without ever being assigned a runner
(no steps, no downloadable logs — a billing symptom, not a bug in the
checker).

Two safeguards from that incident are worth keeping regardless of billing:

- `timeout-minutes` on the job and on the check step. Without it a single
  hung step runs until GitHub's 6-hour ceiling; that happened twice on
  2026-08-17/18 and burned ~720 minutes in one night.
- `npx playwright install chromium` **without** `--with-deps`. The
  `--with-deps` flag triggers an `apt-get` install on the runner, which is
  what hung on those two occasions. The `ubuntu-latest` image already has
  the libraries Chromium needs.
