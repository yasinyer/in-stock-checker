/**
 * Tests for the COS size-chip parser.
 *
 * This parser is the single point of failure for the whole COS watch: if it
 * misreads the page, the checker reports "out of stock" forever and the
 * restock notification never fires. It is also the part most likely to break
 * silently, since COS can change their markup at any time and the sandbox
 * cannot reach cos.com to notice.
 *
 * The markup below mirrors the shapes the real page renders — a size chip is
 * either the bare size, or the size followed by "Notify me" — driven through
 * a real Chromium page via setContent, so no network is needed.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readSizeChips } from "../src/check-cos.mjs";

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

async function chipsFor(html) {
  await page.setContent(`<html><body>${html}</body></html>`);
  return readSizeChips(page);
}

function labelled(chips) {
  return chips.map((c) => `${c.label}${c.soldOut ? "(x)" : "(ok)"}`).join(" ");
}

test("reads one purchasable size among sold-out ones", async () => {
  const chips = await chipsFor(`
    <button>XS<span>Notify me</span></button>
    <button>S</button>
    <button>M<span>Notify me</span></button>
  `);
  assert.equal(labelled(chips), "XS(x) S(ok) M(x)");
});

test("reads every size as sold out", async () => {
  const chips = await chipsFor(`
    <button>XS<span>Notify me</span></button>
    <button>S<span>Notify me</span></button>
    <button>M<span>Notify me</span></button>
  `);
  assert.equal(labelled(chips), "XS(x) S(x) M(x)");
});

test("keeps the outer chip so a nested label does not lose its sold-out marker", async () => {
  // The bare <span>M</span> nested inside the button must not win over the
  // button itself, or M would read as purchasable.
  const chips = await chipsFor(`
    <ul>
      <li><button><span>S</span></button></li>
      <li><button><span>M</span><span>Notify me</span></button></li>
    </ul>
  `);
  assert.equal(labelled(chips), "S(ok) M(x)");
});

test("a size repeated across renders is sold out if any copy says so", async () => {
  // COS ships a desktop and a mobile size picker; only one is visible.
  const chips = await chipsFor(`
    <div><button>S</button></div>
    <div><button>S<span>Notify me</span></button></div>
  `);
  assert.equal(labelled(chips), "S(x)");
});

test("throws instead of reporting 'out of stock' when no sizes render", async () => {
  // The important one: a blocked page, a redirect, or changed markup must
  // surface as a failure, not masquerade as a sold-out product.
  await assert.rejects(() => chipsFor("<div>no sizes here</div>"), /no size chips rendered/);
});

test("ignores page text that merely contains a size letter", async () => {
  const chips = await chipsFor(`
    <a>Shipping</a>
    <li>Size guide</li>
    <button>S</button>
  `);
  assert.equal(labelled(chips), "S(ok)");
});
