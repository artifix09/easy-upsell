import test from 'node:test';
import assert from 'node:assert/strict';
import { distinctProductIds, COPURCHASE_CONFIG } from '../copurchase-index.mjs';

test('distinctProductIds dedups and stringifies product IDs', () => {
  const ids = distinctProductIds([
    { product_id: 10, quantity: 1 },
    { product_id: 10, quantity: 2 },
    { product_id: 20, quantity: 1 },
  ]);
  assert.deepEqual(ids, ['10', '20']);
});

test('distinctProductIds skips line items with no product_id', () => {
  const ids = distinctProductIds([
    { product_id: null, quantity: 1 },   // custom line item / tip
    { product_id: 5, quantity: 1 },
    { quantity: 1 },                      // gift wrap, no product_id
  ]);
  assert.deepEqual(ids, ['5']);
});

test('distinctProductIds caps pair explosion on huge orders', () => {
  const lineItems = [];
  for (let i = 0; i < 100; i++) lineItems.push({ product_id: i, quantity: 1 });
  const ids = distinctProductIds(lineItems);
  assert.equal(ids.length, COPURCHASE_CONFIG.MAX_PRODUCTS_PER_ORDER);
});

test('distinctProductIds handles empty / missing input', () => {
  assert.deepEqual(distinctProductIds([]), []);
  assert.deepEqual(distinctProductIds(null), []);
  assert.deepEqual(distinctProductIds(undefined), []);
});
