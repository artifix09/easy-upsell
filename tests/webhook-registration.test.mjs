import test from 'node:test';
import assert from 'node:assert/strict';
import { SUBSCRIPTIONS, isDuplicateError } from '../webhook-registration.mjs';

test('SUBSCRIPTIONS covers every operational topic with a handler path', () => {
  const topics = SUBSCRIPTIONS.map((s) => s.topic);
  for (const required of [
    'PRODUCTS_CREATE',
    'PRODUCTS_UPDATE',
    'PRODUCTS_DELETE',
    'INVENTORY_LEVELS_UPDATE',
    'ORDERS_CREATE',
    'ORDERS_CANCELLED',
    'APP_UNINSTALLED',
  ]) {
    assert.ok(topics.includes(required), `missing topic ${required}`);
  }
  for (const sub of SUBSCRIPTIONS) {
    assert.match(sub.path, /^\/webhooks\//);
  }
});

test('isDuplicateError detects Shopify "already taken" userErrors', () => {
  assert.equal(
    isDuplicateError([{ message: 'Address for this topic has already been taken' }]),
    true,
  );
  assert.equal(
    isDuplicateError([{ message: 'Subscription already exists' }]),
    true,
  );
});

test('isDuplicateError ignores unrelated userErrors', () => {
  assert.equal(isDuplicateError([]), false);
  assert.equal(
    isDuplicateError([{ message: 'Callback URL is not a valid https URL' }]),
    false,
  );
});
