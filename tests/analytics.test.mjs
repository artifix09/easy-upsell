import test from 'node:test';
import assert from 'node:assert/strict';
import { _toCents } from '../analytics.mjs';

test('_toCents converts price strings to integer cents', () => {
  assert.equal(_toCents('19.99'), 1999);
  assert.equal(_toCents('0.01'), 1);
  assert.equal(_toCents('100'), 10000);
  assert.equal(_toCents('5.005'), 501); // rounds
});

test('_toCents returns null for non-numeric / missing input', () => {
  assert.equal(_toCents(null), null);
  assert.equal(_toCents(undefined), null);
  assert.equal(_toCents('not-a-price'), null);
});
