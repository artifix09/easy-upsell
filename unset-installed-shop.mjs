import { createClient } from 'redis';

const shop = process.argv[2];
if (!shop) {
  console.error('Usage: node unset-installed-shop.mjs <shop.myshopify.com>');
  process.exit(1);
}

const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (err) => console.error('[redis]', err.message));
await redis.connect();

await redis.del(`hybrid:shop:installed:${shop}`);
console.log(`[hybrid] removed installed: ${shop}`);

await redis.quit();
