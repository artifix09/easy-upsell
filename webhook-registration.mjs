// =============================================================================
// Webhook Registration
// =============================================================================
// Registers the app's operational webhook subscriptions with a shop right
// after OAuth install. Idempotent: Shopify rejects duplicate (topic, endpoint)
// pairs with a userError, which we treat as "already registered" and skip.
//
// GDPR/compliance webhooks (customers/data_request, customers/redact,
// shop/redact) are declared in the app config / Partner Dashboard, not here —
// Shopify requires them to be set at the app level, not per-shop.
//
// Endpoint URLs are derived from APP_URL. APP_URL must be https (Shopify
// rejects http callback URLs).
// =============================================================================

import { adminGraphQL } from './shopify-admin-graphql.mjs';

// topic (GraphQL enum) → handler path mounted in the Express apps
const SUBSCRIPTIONS = [
  { topic: 'PRODUCTS_CREATE', path: '/webhooks/products/create' },
  { topic: 'PRODUCTS_UPDATE', path: '/webhooks/products/update' },
  { topic: 'PRODUCTS_DELETE', path: '/webhooks/products/delete' },
  { topic: 'INVENTORY_LEVELS_UPDATE', path: '/webhooks/inventory/update' },
  { topic: 'ORDERS_CREATE', path: '/webhooks/orders/create' },
  { topic: 'ORDERS_CANCELLED', path: '/webhooks/orders/cancelled' },
  { topic: 'APP_UNINSTALLED', path: '/webhooks/app/uninstalled' },
];

const CREATE_MUTATION = `
  mutation RegisterWebhook($topic: WebhookSubscriptionTopic!, $url: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $url, format: JSON }
    ) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

function logReg(event, data = {}) {
  console.log(JSON.stringify({
    component: 'webhook_registration',
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}

// "already taken" / "for this topic has already been taken" — Shopify's
// duplicate-subscription userError. Safe to treat as success.
function isDuplicateError(userErrors) {
  return userErrors.some((e) => /already been taken|already exists/i.test(e.message || ''));
}

export async function registerWebhooks(shop) {
  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!appUrl || !appUrl.startsWith('https://')) {
    logReg('skipped', { shop, reason: 'app_url_not_https' });
    return { ok: false, registered: 0, error: 'APP_URL must be https' };
  }

  let registered = 0;
  let duplicates = 0;
  let failed = 0;

  for (const sub of SUBSCRIPTIONS) {
    const url = `${appUrl}${sub.path}`;
    try {
      const data = await adminGraphQL(shop, CREATE_MUTATION, { topic: sub.topic, url });
      const result = data?.webhookSubscriptionCreate;
      const userErrors = result?.userErrors || [];

      if (result?.webhookSubscription?.id) {
        registered++;
      } else if (isDuplicateError(userErrors)) {
        duplicates++;
      } else {
        failed++;
        logReg('register_failed', {
          shop,
          topic: sub.topic,
          errors: userErrors.map((e) => e.message),
        });
      }
    } catch (err) {
      failed++;
      logReg('register_error', { shop, topic: sub.topic, message: err.message });
    }
  }

  logReg('register_complete', { shop, registered, duplicates, failed });
  return { ok: failed === 0, registered, duplicates, failed };
}

export { SUBSCRIPTIONS, isDuplicateError };
