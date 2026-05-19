import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyProxyHmac,
  verifyWebhookHmac,
  verifyAppProxySignature,
  verifyOAuthHmac,
  signAppProxyQuery,
} from '../hmac-validators.mjs';

const secret = 'test_secret';
const body = Buffer.from('{"cart_items":[{"product_id":1,"variant_id":2,"quantity":1}]}');

function signBase64(payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

test('verifyWebhookHmac: valid', () => {
  const signature = signBase64(body);
  const result = verifyWebhookHmac({ secret, rawBody: body, signature });
  assert.equal(result.ok, true);
});

test('verifyWebhookHmac: invalid', () => {
  const result = verifyWebhookHmac({ secret, rawBody: body, signature: 'invalid' });
  assert.equal(result.ok, false);
});

test('verifyWebhookHmac: missing signature', () => {
  const result = verifyWebhookHmac({ secret, rawBody: body, signature: '' });
  assert.equal(result.ok, false);
});

test('verifyProxyHmac (legacy alias) still verifies body', () => {
  const signature = signBase64(body);
  const result = verifyProxyHmac({ secret, rawBody: body, signature });
  assert.equal(result.ok, true);
});

test('verifyAppProxySignature: valid query signature', () => {
  const query = {
    shop: 'shop.myshopify.com',
    timestamp: '1717000000',
    path_prefix: '/apps/hybrid',
  };
  query.signature = signAppProxyQuery(secret, query);
  const result = verifyAppProxySignature({ secret, query });
  assert.equal(result.ok, true);
});

test('verifyAppProxySignature: array values joined with comma', () => {
  const query = {
    shop: 'shop.myshopify.com',
    timestamp: '1717000000',
    extra: ['1', '2'],
  };
  query.signature = signAppProxyQuery(secret, query);
  const result = verifyAppProxySignature({ secret, query });
  assert.equal(result.ok, true);
});

test('verifyAppProxySignature: missing signature', () => {
  const result = verifyAppProxySignature({
    secret,
    query: { shop: 'shop.myshopify.com', timestamp: '1717000000' },
  });
  assert.equal(result.ok, false);
});

test('verifyAppProxySignature: tampered param invalidates', () => {
  const query = {
    shop: 'shop.myshopify.com',
    timestamp: '1717000000',
  };
  query.signature = signAppProxyQuery(secret, query);
  query.shop = 'other.myshopify.com';
  const result = verifyAppProxySignature({ secret, query });
  assert.equal(result.ok, false);
});

test('verifyOAuthHmac: valid query', () => {
  const params = {
    code: 'abc123',
    shop: 'shop.myshopify.com',
    state: 'nonce',
    timestamp: '1717000000',
  };
  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const hmac = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const result = verifyOAuthHmac({ secret, query: { ...params, hmac } });
  assert.equal(result.ok, true);
});

test('verifyOAuthHmac: bad hmac rejected', () => {
  const result = verifyOAuthHmac({
    secret,
    query: {
      code: 'abc123',
      shop: 'shop.myshopify.com',
      state: 'nonce',
      timestamp: '1717000000',
      hmac: 'deadbeef',
    },
  });
  assert.equal(result.ok, false);
});
