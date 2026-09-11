# in-stock-checker

Checks product pages (Uniqlo, COS, H&M, Upfront) for stock availability or a
discount, and sends a free push notification (via [ntfy.sh](https://ntfy.sh))
as soon as something changes.

## How it works

- `products.json` lists the products to watch. It deliberately contains no
  ntfy topic — see [Notification topic](#notification-topic) below.
- `src/check-stock.mjs` is the entrypoint that runs all checks:
  - **Uniqlo** entries (no `type` field) are checked via Uniqlo's internal
    commerce API for the color encoded in the URL's query string
    (`colorDisplayCode`, plus `pldDisplayCode` where a product has one).
    Sizes come from a `sizes` list of names — `["L", "XL"]` — and any one of
    them coming into stock is worth a notification; the names are resolved to
    the API's opaque display codes at run time. Items flagged "coming soon"
    (not yet purchasable, even with warehouse stock) count as unavailable.
  - **COS** entries (`"type": "cos"`) are checked via `src/check-cos.mjs`
    using Playwright (headless Chromium), because COS.com sits behind Akamai
    bot protection. Every color variant listed in `colorVariants` is visited
    and the target size is available when its size chip does not show
    "Notify me". **Currently blocked — see below.**
  - **H&M** entries (`"type": "hm"`) are checked via `src/check-hm.mjs`.
    `www2.hm.com` is behind the same Akamai block as COS, but `api.hm.com` is
    not: querying its search service with a full article id returns that one
    product with per-size stock, so no browser is needed.
  - **Upfront** entries (`"type": "upfront"`) are checked via
    `src/check-upfront.mjs`. Upfront runs on Shopify, so `/products/<handle>.js`
    returns every variant with its availability and price — no browser needed.
    This watches for a *discount*, not for stock; see
    [Discount detection](#discount-detection).
- `state.json` remembers the availability from the last check, so a
  notification is only sent on the transition unavailable -> available
  (not on every run).
- `.github/workflows/check-stock.yml` runs the check once a day (07:00 UTC)
  via GitHub Actions and commits the updated `state.json` back to the repo.
  You can also trigger it on demand from the Actions tab.

## Currently watched

- **COS Slim Ribbed Cotton Tank Top** — back in stock in size S, in any color
  except black/grey/white (Navy, Khaki, Blue, Light Mole, Dark Mole, Beige
  Mélange, Dark Brown).
- **COS Long Sleeved Henley Top, Grey Mélange** — back in stock in size S.
- **Uniqlo Soft Cotton Zip Cardigan, grey** — back in stock in size L or XL.
- **H&M Ribbed Cotton Henley Slim Fit, white** — back in stock in size S.
- **Upfront Whey Milkshake** — *discounted* in any flavour. This one watches
  price, not stock; see below.

## Known issue: COS blocks the runner

As of 2026-09-11 both COS watches fail. Akamai serves the GitHub Actions
runner an **"Access Denied"** page instead of the product, so the checker
reports `no size chips rendered` and the run goes red. This is a bot block on
the data-centre IP, not a markup change: the error message carries the page
title and body, and they read `Access Denied … you don't have permission to
access … on this server`.

The failure is left visible on purpose. Before the parser rewrite, a blocked
page returned "out of stock", which is indistinguishable from the real thing —
so the watch could have sat dead for weeks while looking healthy. A red run
is the honest signal.

Options, none of which the checker can do by itself:

- **Use COS's own "Notify me" button** on the product page. It is the same
  feature, first-party and sanctioned, and needs no infrastructure.
- **Run this on a machine with a residential IP** (a home server, a
  Raspberry Pi) via a self-hosted runner, rather than on GitHub's.

Escalating the evasion — residential proxies, deeper fingerprint spoofing —
would be working around an access control COS clearly intends, so it is not
done here.

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

### Verifying the chain

The secret cannot be read back, so the only way to confirm it holds the topic
you are actually subscribed to is to send through it. In the Actions tab, run
**Check stock** with **"Send a test notification instead of checking stock"**
ticked. It publishes one notification per configured topic using the secret
and skips the stock check entirely, so it finishes in seconds.

Locally the same thing:

```bash
NTFY_TOPIC=your-topic npm run check -- --test-notification
```

## Discount detection

Shopify's own signal for "on sale" is `compare_at_price > price`, and Upfront
does use it for genuine sales. Relying on it alone would not be enough here,
though: the shop also leaves stale values behind. On the Whey Milkshake every
available flavour sits at a price of 3800 with a `compare_at_price` of 3600 —
a "was" price *below* the current one, which is not a discount at all. 69 of
the store's 276 variants are inverted like that.

So a real price cut that leaves `compare_at_price` untouched could stay
invisible. The checker therefore treats a variant as discounted when it is
purchasable **and** either:

1. `compare_at_price > price` — a proper sale flag, caught on the first check; or
2. `price` has dropped below the **baseline** recorded for that variant.

The baseline is the highest price ever seen for a variant, kept in
`state.json`. It only ever rises, so a sale price never quietly becomes the new
"normal" and silences the next sale. On the very first run the baseline is
simply the current price, so no notification fires for prices that were already
what they are.

## Add another product to watch

Add an entry to `products.json`. For Uniqlo:

```json
{
  "label": "Readable name for notifications",
  "url": "https://www.uniqlo.com/<region>/<locale>/products/<id>/<priceGroup>?colorDisplayCode=..",
  "sizes": ["L", "XL"]
}
```

Write `sizes` as the names the site shows, not the URL's `sizeDisplayCode` —
a code is unreadable and would quietly watch the wrong size if Uniqlo ever
renumbered them. An unknown name fails the run and lists what the product
does offer. Omit `sizes` and the single `sizeDisplayCode` from the URL is
used instead.

For COS, use `"type": "cos"` with a `targetSize` and a `colorVariants` list
(see the existing entry in `products.json` as a template).

For H&M, use `"type": "hm"` with the `articleId` from the product URL
(`productpage.<articleId>.html`), a `locale` such as `nl_BE`, and a `sizes`
list of names. Note that H&M's product-level `availability.stockState` reads
"Available" even when the size you want is at stock 0, so only the per-size
stock is trusted.

All products share the `NTFY_TOPIC` topic. To send one product elsewhere,
give it an `"ntfyTopicEnv": "SOME_OTHER_VAR"` field and add that secret too.

## Run locally

```bash
npm install
npx playwright install --with-deps chromium
NTFY_TOPIC=your-topic npm run check
```

## Tests

```bash
npm test
```

`test/size-parsing.test.mjs` drives the COS size parser against representative
markup in a real Chromium page, so it needs no network — handy, because COS
blocks most environments that are not a GitHub runner.

That parser decides whether a restock notification ever fires, and it is the
part most likely to break quietly when COS changes their markup. The tests
pin down the cases that matter: a purchasable size among sold-out ones, a
product where *every* size is sold out (the normal state of anything worth
watching), a nested chip whose "Notify me" marker must not get lost, and a
page with no sizes at all — which must raise an error rather than masquerade
as "out of stock". CI runs them before every check.

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
