# in-stock-checker

Checks Uniqlo product pages for stock availability and sends a free push
notification (via [ntfy.sh](https://ntfy.sh)) as soon as a watched item is
back in stock.

## How it works

- `products.json` lists the Uniqlo product URLs to watch, each with an
  `ntfyTopic` to publish a notification to.
- `src/check-stock.mjs` calls Uniqlo's internal commerce API for the
  product/color/size combination encoded in the URL's query string
  (`colorDisplayCode`, `sizeDisplayCode`, `pldDisplayCode`) and checks the
  stock status and quantity. Items that are flagged "coming soon" (i.e. not
  yet purchasable, even if warehouse stock exists) are treated as
  unavailable.
- `state.json` remembers whether each product was available on the last
  check, so a notification is only sent on the transition from
  unavailable -> available (not on every run).
- `.github/workflows/check-stock.yml` runs the check every 15 minutes via
  GitHub Actions and commits the updated `state.json` back to the repo.

## Get notified

1. Install the [ntfy app](https://ntfy.sh/) (iOS/Android) or open
   `https://ntfy.sh/<topic>` in a browser.
2. Subscribe to the topic configured for your product in `products.json`
   (currently `instock-checker-yasinyer-99dfaec1b4ac`).
3. That's it — no account or credentials needed. Anyone who knows the topic
   name can publish/subscribe to it, so it's not a private channel, but the
   random suffix makes it hard to guess.

## Add another product to watch

Add an entry to `products.json`:

```json
{
  "label": "Readable name for notifications",
  "url": "https://www.uniqlo.com/<region>/<locale>/products/<id>/<priceGroup>?colorDisplayCode=..&sizeDisplayCode=..",
  "ntfyTopic": "pick-your-own-random-topic-name"
}
```

## Run locally

```bash
npm run check
```

## Note on GitHub Actions schedules

GitHub only runs the `schedule` trigger for workflows that live on the
repository's default branch. Once this branch is merged into `main`, the
15-minute check will start running automatically; until then you can trigger
it manually from the Actions tab (`workflow_dispatch`).
