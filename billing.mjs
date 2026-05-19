// =============================================================================
// Billing — Shopify Billing API (recurring app subscription)
// =============================================================================
// A paid app must use Shopify's Billing API; merchant-entered card data never
// touches us. Flow:
//
//   1. Admin UI calls POST /admin/api/billing/subscribe.
//   2. createSubscription() runs appSubscriptionCreate and returns a
//      confirmationUrl. The UI redirects the merchant there.
//   3. Merchant approves on Shopify. Shopify redirects to BILLING_RETURN_URL
//      (GET /billing/callback?shop=...).
//   4. handleBillingCallback() re-queries activeSubscriptions (Shopify is the
//      source of truth) and persists plan + status to Postgres.
//
// getBillingStatus() is the gate: routes/features that require a paid plan
// check it. In development, set BILLING_TEST=true (default) so subscriptions
// are test charges that never bill a real card.
// =============================================================================

import { adminGraphQL } from './shopify-admin-graphql.mjs';
import { setBilling, getBilling } from './postgres-store.mjs';

const CONFIG = {
  APP_URL: (process.env.APP_URL || '').replace(/\/+$/, ''),
  // Test mode unless explicitly disabled — protects against real charges in dev.
  TEST_MODE: process.env.BILLING_TEST !== 'false',
};

// Single plan for v1. Add entries here as the pricing model grows.
const PLANS = {
  standard: {
    key: 'standard',
    name: 'Standard',
    amount: '19.99',
    currencyCode: 'USD',
    interval: 'EVERY_30_DAYS',
    trialDays: 7,
  },
};

function logBilling(event, data = {}) {
  console.log(JSON.stringify({
    component: 'billing',
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}

const ACTIVE_SUBS_QUERY = `
  query ActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions { id name status }
    }
  }
`;

const CREATE_SUB_MUTATION = `
  mutation CreateSubscription(
    $name: String!
    $returnUrl: URL!
    $trialDays: Int
    $test: Boolean!
    $amount: Decimal!
    $currencyCode: CurrencyCode!
    $interval: AppPricingInterval!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      trialDays: $trialDays
      test: $test
      lineItems: [{
        plan: {
          appRecurringPricingDetails: {
            price: { amount: $amount, currencyCode: $currencyCode }
            interval: $interval
          }
        }
      }]
    ) {
      appSubscription { id status }
      confirmationUrl
      userErrors { field message }
    }
  }
`;

// --------------------------------------------------------------------------
// READ: current billing status
// --------------------------------------------------------------------------
// Prefers the persisted Postgres value (fast). When `verify` is true, also
// re-queries Shopify and reconciles — used by the callback and as a periodic
// drift check.

export async function getBillingStatus(shop, { verify = false } = {}) {
  const stored = await getBilling(shop);

  if (!verify) {
    return {
      active: stored?.status === 'ACTIVE',
      plan: stored?.plan || null,
      status: stored?.status || null,
    };
  }

  try {
    const data = await adminGraphQL(shop, ACTIVE_SUBS_QUERY);
    const subs = data?.currentAppInstallation?.activeSubscriptions || [];
    const active = subs.find((s) => s.status === 'ACTIVE') || null;

    if (active) {
      await setBilling(shop, { plan: planKeyFromName(active.name), subscriptionId: active.id, status: 'ACTIVE' });
      return { active: true, plan: planKeyFromName(active.name), status: 'ACTIVE' };
    }

    // No active subscription on Shopify's side — clear stale state.
    if (stored?.status === 'ACTIVE') {
      await setBilling(shop, { plan: null, subscriptionId: null, status: 'CANCELLED' });
    }
    return { active: false, plan: null, status: 'CANCELLED' };
  } catch (err) {
    logBilling('verify_failed', { shop, message: err.message });
    // Fall back to stored state rather than locking the merchant out on a
    // transient API error.
    return {
      active: stored?.status === 'ACTIVE',
      plan: stored?.plan || null,
      status: stored?.status || null,
    };
  }
}

function planKeyFromName(name) {
  const match = Object.values(PLANS).find((p) => p.name === name);
  return match ? match.key : null;
}

// --------------------------------------------------------------------------
// WRITE: start a subscription — returns a confirmationUrl for the merchant
// --------------------------------------------------------------------------

export async function createSubscription(shop, planKey = 'standard') {
  const plan = PLANS[planKey];
  if (!plan) {
    return { ok: false, error: `Unknown plan: ${planKey}` };
  }
  if (!CONFIG.APP_URL.startsWith('https://')) {
    return { ok: false, error: 'APP_URL must be https for billing return URL.' };
  }

  const returnUrl = `${CONFIG.APP_URL}/billing/callback?shop=${encodeURIComponent(shop)}`;

  try {
    const data = await adminGraphQL(shop, CREATE_SUB_MUTATION, {
      name: plan.name,
      returnUrl,
      trialDays: plan.trialDays,
      test: CONFIG.TEST_MODE,
      amount: plan.amount,
      currencyCode: plan.currencyCode,
      interval: plan.interval,
    });

    const result = data?.appSubscriptionCreate;
    const userErrors = result?.userErrors || [];
    if (userErrors.length > 0) {
      const messages = userErrors.map((e) => e.message);
      logBilling('create_user_errors', { shop, errors: messages });
      // Shopify returns this when the app's Partner Dashboard "Distribution"
      // is set to "Custom app". The Billing API is only available for apps
      // distributed via the Shopify App Store. Surface a clear, actionable
      // message instead of the raw Shopify text.
      const isCustomAppLimit = messages.some((m) => /custom apps cannot use the billing api/i.test(m));
      if (isCustomAppLimit) {
        return {
          ok: false,
          code: 'CUSTOM_APP_BILLING_BLOCKED',
          error: 'This app is configured as a Custom app in Shopify Partners, which cannot use Shopify Billing. To accept payments, change the app distribution to Public app (Shopify App Store) in the Partner Dashboard. For development, you can keep using the app for free.',
        };
      }
      return { ok: false, error: messages[0] };
    }
    if (!result?.confirmationUrl) {
      return { ok: false, error: 'Shopify did not return a confirmation URL.' };
    }

    // Persist as PENDING until the merchant approves and the callback confirms.
    await setBilling(shop, {
      plan: plan.key,
      subscriptionId: result.appSubscription?.id || null,
      status: result.appSubscription?.status || 'PENDING',
    });

    logBilling('subscription_created', { shop, plan: plan.key, test: CONFIG.TEST_MODE });
    return { ok: true, confirmationUrl: result.confirmationUrl, plan: plan.key };
  } catch (err) {
    logBilling('create_failed', { shop, message: err.message });
    return { ok: false, error: 'Failed to create subscription.' };
  }
}

// --------------------------------------------------------------------------
// CALLBACK: merchant returned from Shopify's approval screen
// --------------------------------------------------------------------------

export async function handleBillingCallback(shop) {
  // Shopify is the source of truth — re-query rather than trust the redirect.
  const status = await getBillingStatus(shop, { verify: true });
  logBilling('callback_reconciled', { shop, active: status.active, plan: status.plan });
  return status;
}

export { PLANS, CONFIG as BILLING_CONFIG };
