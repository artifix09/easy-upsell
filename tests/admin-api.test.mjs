import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

// admin-api.mjs reads env at import; set BEFORE importing.
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || 'test-api-key';
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || 'test-api-secret';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const { app, _validateRule } = await import('../admin-api.mjs');

// --------------------------------------------------------------------------
// Pure validation tests — no I/O.
// --------------------------------------------------------------------------

test('validateRule accepts a valid percentage rule', () => {
  const v = _validateRule({ type: 'percentage', value: 10, label: 'Save 10%', active: true });
  assert.equal(v.ok, true);
  assert.equal(v.rule.type, 'percentage');
  assert.equal(v.rule.value, 10);
  assert.equal(v.rule.active, true);
});

test('validateRule accepts fixed_amount and coerces numeric strings', () => {
  const v = _validateRule({ type: 'fixed_amount', value: '5.50', label: '$5.50 off' });
  assert.equal(v.ok, true);
  assert.equal(v.rule.value, 5.5);
  assert.equal(v.rule.active, true); // defaults to true when omitted
});

test('validateRule rejects unknown type', () => {
  const v = _validateRule({ type: 'bogus', value: 10 });
  assert.equal(v.ok, false);
  assert.match(v.error, /type must be one of/);
});

test('validateRule rejects non-positive value', () => {
  assert.equal(_validateRule({ type: 'percentage', value: 0 }).ok, false);
  assert.equal(_validateRule({ type: 'percentage', value: -1 }).ok, false);
  assert.equal(_validateRule({ type: 'percentage', value: 'abc' }).ok, false);
});

test('validateRule caps percentage at 100', () => {
  const v = _validateRule({ type: 'percentage', value: 150 });
  assert.equal(v.ok, false);
  assert.match(v.error, /between 0 and 100/);
});

test('validateRule rejects oversized label', () => {
  const v = _validateRule({ type: 'percentage', value: 10, label: 'x'.repeat(200) });
  assert.equal(v.ok, false);
});

test('validateRule rejects non-object body', () => {
  assert.equal(_validateRule(null).ok, false);
  assert.equal(_validateRule('string').ok, false);
});

// --------------------------------------------------------------------------
// HTTP-level tests — boots the express app on an ephemeral port, exercises
// the auth boundary. No Redis/Postgres required because /admin/api/* is
// rejected by the session-token middleware before any handler runs.
// --------------------------------------------------------------------------

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method, host: '127.0.0.1', port, path, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try { json = JSON.parse(raw); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
        });
      },
    );
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function makeSessionToken({ shop = 'demo.myshopify.com', expIn = 60, audience = process.env.SHOPIFY_API_KEY } = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    aud: audience,
    sub: '1',
    exp: now + expIn,
    nbf: now - 1,
    iat: now,
    jti: 'test',
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const h = b64(header);
  const p = b64(payload);
  const sig = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(`${h}.${p}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${h}.${p}.${sig}`;
}

test('GET /admin/api/status without token → 401 UNAUTHORIZED', async () => {
  const server = await startServer();
  try {
    const r = await request(server, { path: '/admin/api/status' });
    assert.equal(r.status, 401);
    assert.equal(r.json?.error?.code, 'UNAUTHORIZED');
  } finally {
    server.close();
  }
});

test('GET /admin/api/status with invalid bearer → 401', async () => {
  const server = await startServer();
  try {
    const r = await request(server, {
      path: '/admin/api/status',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    assert.equal(r.status, 401);
  } finally {
    server.close();
  }
});

test('PUT /admin/api/discount-rules rejects non-numeric productId before touching DB', async () => {
  const server = await startServer();
  try {
    const token = makeSessionToken();
    const r = await request(server, {
      method: 'PUT',
      path: '/admin/api/discount-rules/not-a-number',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: { type: 'percentage', value: 10 },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json?.error?.code, 'VALIDATION_ERROR');
  } finally {
    server.close();
  }
});

test('PUT /admin/api/discount-rules rejects malformed rule before touching DB', async () => {
  const server = await startServer();
  try {
    const token = makeSessionToken();
    const r = await request(server, {
      method: 'PUT',
      path: '/admin/api/discount-rules/12345',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: { type: 'bogus', value: 10 },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json?.error?.code, 'VALIDATION_ERROR');
  } finally {
    server.close();
  }
});

test('GET /billing/callback rejects invalid shop param', async () => {
  const server = await startServer();
  try {
    const r = await request(server, { path: '/billing/callback?shop=evil.example.com' });
    assert.equal(r.status, 400);
    assert.equal(r.json?.error?.code, 'VALIDATION_ERROR');
  } finally {
    server.close();
  }
});
