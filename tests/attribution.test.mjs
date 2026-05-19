import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRecAttribution } from '../analytics.mjs';

test('extractRecAttribution reads webhook array-shape properties', () => {
  const line = {
    product_id: 100,
    properties: [
      { name: '_some_other', value: 'x' },
      { name: '_hybrid_rec', value: '8172640100' },
    ],
  };
  assert.equal(extractRecAttribution(line), '8172640100');
});

test('extractRecAttribution reads cart.js object-shape properties', () => {
  const line = {
    product_id: 100,
    properties: { _hybrid_rec: 8172640100, gift_note: 'hi' },
  };
  assert.equal(extractRecAttribution(line), '8172640100');
});

test('extractRecAttribution returns null when property absent', () => {
  assert.equal(extractRecAttribution({ product_id: 1, properties: [] }), null);
  assert.equal(extractRecAttribution({ product_id: 1, properties: {} }), null);
  assert.equal(extractRecAttribution({ product_id: 1 }), null);
});

test('extractRecAttribution handles malformed inputs without throwing', () => {
  assert.equal(extractRecAttribution(null), null);
  assert.equal(extractRecAttribution(undefined), null);
  assert.equal(extractRecAttribution('not-an-object'), null);
  assert.equal(extractRecAttribution({ properties: 'string' }), null);
  assert.equal(extractRecAttribution({ properties: [null, undefined, { name: '_hybrid_rec', value: null }] }), null);
});

test('extractRecAttribution coerces non-string values', () => {
  assert.equal(extractRecAttribution({ properties: { _hybrid_rec: 42 } }), '42');
  assert.equal(extractRecAttribution({ properties: [{ name: '_hybrid_rec', value: 42 }] }), '42');
});
