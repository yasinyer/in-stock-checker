/**
 * Tests for picking sizes out of a H&M product.
 *
 * The fixtures below are the shape api.hm.com actually returned for article
 * 1359341002 — including the trap that motivated the code: a product-level
 * `availability.stockState` of "Available" sitting next to the wanted size at
 * stock 0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSizes } from "../src/check-hm.mjs";

// Real response shape: white Henley, only XL and XXL actually buyable.
const PRODUCT = {
  id: "1359341002",
  productName: "Henleyshirt van geribd katoen Slim Fit",
  colorName: "Wit",
  availability: { stockState: "Available", comingSoon: false },
  sizes: [
    { id: "001", label: "XS", stock: 0 },
    { id: "002", label: "S", stock: 0 },
    { id: "003", label: "M", stock: 0 },
    { id: "004", label: "L", stock: 0 },
    { id: "005", label: "XL", stock: 2 },
    { id: "006", label: "XXL", stock: 2 },
  ],
};

test("a sold-out size is not available, whatever the product-level flag says", () => {
  // stockState is "Available" here. Trusting it would announce a restock of a
  // size that cannot be bought.
  const [s] = selectSizes(PRODUCT, ["S"]);
  assert.equal(s.available, false);
  assert.equal(s.stock, 0);
});

test("a size with stock is available", () => {
  const [xl] = selectSizes(PRODUCT, ["XL"]);
  assert.equal(xl.available, true);
});

test("reads several sizes at once", () => {
  const got = selectSizes(PRODUCT, ["S", "XL"]);
  assert.deepEqual(
    got.map((r) => [r.name, r.available]),
    [
      ["S", false],
      ["XL", true],
    ],
  );
});

test("size names are matched case-insensitively", () => {
  const [xxl] = selectSizes(PRODUCT, ["xxl"]);
  assert.equal(xxl.name, "XXL");
  assert.equal(xxl.available, true);
});

test("an unknown size fails loudly and lists what is offered", () => {
  assert.throws(
    () => selectSizes(PRODUCT, ["XXXL"]),
    /size XXXL not offered — available: XS, S, M, L, XL, XXL/,
  );
});

test("a product with no sizes fails rather than reporting nothing available", () => {
  assert.throws(() => selectSizes({ id: "1", sizes: [] }, ["S"]), /no sizes/);
  assert.throws(() => selectSizes({ id: "1" }, ["S"]), /no sizes/);
});
