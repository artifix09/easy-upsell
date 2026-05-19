import fs from 'node:fs';
import { createClient } from 'redis';

const shop = process.argv[2];
if (!shop) {
  console.error('Usage: node warm-indexes.mjs <shop.myshopify.com>');
  process.exit(1);
}

const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (err) => console.error('[redis]', err.message));
await redis.connect();

// This is a placeholder script that accepts a pre-normalized catalog file.
// Later, replace with Admin API sync to build indexes from the full catalog.
const catalogPath = process.argv[3] || '';
if (!catalogPath) {
  console.error('Provide a normalized catalog JSON file as the second argument.');
  process.exit(1);
}

const catalog = JSON.parse(await fs.promises.readFile(catalogPath, 'utf-8'));
const pipeline = redis.multi();

for (const product of catalog.products || []) {
  const pid = String(product.id);
  pipeline.setEx(`hybrid:prod:${shop}:${pid}`, 600, JSON.stringify(product));

  for (const collId of product.collection_ids || []) {
    pipeline.sAdd(`hybrid:idx:coll:${shop}:${collId}`, pid);
    pipeline.expire(`hybrid:idx:coll:${shop}:${collId}`, 3600);
  }

  for (const tag of product.tags || []) {
    pipeline.sAdd(`hybrid:idx:tag:${shop}:${tag}`, pid);
    pipeline.expire(`hybrid:idx:tag:${shop}:${tag}`, 3600);
  }

  if (product.vendor) {
    pipeline.sAdd(`hybrid:idx:vendor:${shop}:${product.vendor}`, pid);
    pipeline.expire(`hybrid:idx:vendor:${shop}:${product.vendor}`, 3600);
  }
}

await pipeline.exec();
console.log(`[hybrid] warmed indexes for ${shop}`);

await redis.quit();
