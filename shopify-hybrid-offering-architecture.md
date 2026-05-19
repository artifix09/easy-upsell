# Shopify Hybrid Offering — Technical Architecture Document

**Version:** 1.0  
**Date:** May 2, 2026  
**Classification:** Internal Engineering Reference  
**Author Role:** Senior Software Architect — Shopify Ecosystem

---

## 1. Executive Summary

This document architects a premium Shopify Theme + companion App that eliminates the "App Bloat" problem. Rather than merchants installing 5–8 separate apps (bundles, upsells, size charts, cart recovery) that each inject their own JavaScript, CSS, and DOM mutations, this hybrid offering consolidates all logic into two tightly-coupled artifacts: a performant OS 2.0 theme and a single companion app communicating via Metafields and App Bridge.

The result: zero external JS libraries, a single DOM observer, native Shopify Functions for discount logic, and a guaranteed 95+ PageSpeed score.

---

## 2. System Boundary Definitions

### 2.1 What Lives in the Theme

The theme owns the entire rendering surface. It is the single source of truth for CSS variables, layout slots, and Web Component definitions. No visual element renders outside the theme's control.

- All CSS custom properties (`:root` declarations)
- Web Component shells (`<hybrid-upsell>`, `<hybrid-size-chart>`, `<hybrid-welcome-back>`)
- Liquid section schemas exposing App-populated Metafields
- Cart/checkout UI extensions referencing theme tokens
- Static asset delivery (zero external CDN dependencies)

### 2.2 What Lives in the App

The app owns all business logic, data persistence, and Shopify Admin interactions. It never touches the storefront DOM directly.

- Bundle configuration UI (Admin Embedded App via App Bridge)
- Abandoned cart tracking and behavioral event ingestion
- Metafield write operations (product bundles, visitor state, upsell rules)
- Shopify Functions deployment (discount logic, cart validation)
- Webhook processing (order creation, cart updates, customer events)

### 2.3 The Communication Contract

Theme and App share no runtime code. All communication flows through three channels:

1. **Metafields** — structured JSON data written by the App and read by the Theme via Liquid
2. **App Bridge** — admin-side event bus for live preview and configuration
3. **Shopify Functions** — server-side logic executing at checkout without client JS

---

## 3. Data Schema

### 3.1 Metafield Namespace Architecture

All metafields live under the `hybrid` namespace to avoid collisions with third-party apps. Each feature area gets a dedicated key prefix.

```
Namespace: hybrid
Owner:     App installation (app-owned metafields)

┌────────────────────────────────────────────────────────────────────┐
│  RESOURCE         KEY                  TYPE        OWNER          │
├────────────────────────────────────────────────────────────────────┤
│  product          hybrid.bundle_config jsonl       App            │
│  product          hybrid.upsell_rules  json        App            │
│  product          hybrid.size_chart    json        App            │
│  shop             hybrid.ui_protocol   json        App            │
│  shop             hybrid.recovery_cfg  json        App            │
│  customer          hybrid.visitor_state json        App            │
│  cart (via note)   hybrid.cart_context  json        App (webhook)  │
└────────────────────────────────────────────────────────────────────┘
```

### 3.2 Bundle Configuration Schema

Stored as a `product` metafield. Written by the app admin UI, read by Liquid sections and Shopify Functions.

```json
{
  "$schema": "hybrid.bundle_config.v1",
  "bundle_id": "bundle_abc123",
  "strategy": "fixed" | "mix_and_match" | "volume_tiered",
  "components": [
    {
      "product_id": "gid://shopify/Product/123",
      "variant_id": "gid://shopify/ProductVariant/456",
      "quantity_min": 1,
      "quantity_max": 3,
      "is_required": true
    }
  ],
  "pricing": {
    "discount_type": "percentage" | "fixed_amount" | "fixed_price",
    "discount_value": 15,
    "applies_to": "bundle_total" | "per_item",
    "stacking_policy": "exclusive" | "best_price" | "stackable"
  },
  "inventory_mode": "component_level",
  "discount_function_id": "hybrid-bundle-discount",
  "validation_function_id": "hybrid-bundle-validate",
  "metadata": {
    "created_at": "2026-05-01T00:00:00Z",
    "version": 3,
    "discount_code_exclusions": ["SUMMER20", "VIP*"]
  }
}
```

### 3.3 UI Protocol Schema

Shop-level metafield that bridges the App's component settings with the Theme's CSS variable system. The theme reads this on every page load via Liquid and injects it into `:root`.

```json
{
  "$schema": "hybrid.ui_protocol.v1",
  "version": 2,
  "theme_binding": "auto",
  "component_overrides": {
    "upsell_drawer": {
      "inherit_from_theme": true,
      "overrides": {
        "--hybrid-upsell-bg": null,
        "--hybrid-upsell-radius": null,
        "--hybrid-upsell-shadow": "0 -4px 24px rgba(0,0,0,0.08)"
      }
    },
    "size_chart": {
      "inherit_from_theme": true,
      "overrides": {
        "--hybrid-chart-header-bg": null
      }
    },
    "welcome_back": {
      "inherit_from_theme": true,
      "overrides": {
        "--hybrid-wb-accent": null
      }
    }
  },
  "typography": {
    "inherit_body_font": true,
    "inherit_heading_font": true
  }
}
```

When a value is `null`, the component falls back to the theme's `:root` variable. When a merchant sets a specific value in the App admin, it overrides the theme default for that component only.

### 3.4 Visitor State Schema (Recovery Flow)

Customer-level metafield tracking behavioral signals for the contextual recovery system.

```json
{
  "$schema": "hybrid.visitor_state.v1",
  "customer_id": "gid://shopify/Customer/789",
  "last_visit": "2026-05-01T14:30:00Z",
  "abandoned_cart": {
    "cart_token": "abc123",
    "items": [
      {
        "product_id": "gid://shopify/Product/123",
        "variant_id": "gid://shopify/ProductVariant/456",
        "title": "Classic Oxford Shirt — Blue / M",
        "quantity": 1,
        "price": "89.00"
      }
    ],
    "total": "89.00",
    "abandoned_at": "2026-05-01T14:25:00Z",
    "recovery_stage": "soft_nudge" | "incentive" | "final_reminder",
    "recovery_discount_code": null
  },
  "browse_history": {
    "recent_collections": ["shirts", "accessories"],
    "viewed_products_last_7d": 12,
    "visit_count_last_30d": 4
  },
  "flags": {
    "is_returning": true,
    "has_abandoned_cart": true,
    "eligible_for_incentive": false
  }
}
```

### 3.5 App Bridge Communication Events

App Bridge handles real-time communication between the admin-embedded app and theme preview. These events are admin-side only and never execute on the storefront.

```
Event Bus (App Bridge v4)

┌─────────────────────────────────────────────────────────────┐
│  EVENT                         DIRECTION     PAYLOAD        │
├─────────────────────────────────────────────────────────────┤
│  hybrid:bundle:preview         App → Theme   bundle_config  │
│  hybrid:upsell:configure       App → Theme   upsell_rules   │
│  hybrid:ui:token_update        App → Theme   css_overrides   │
│  hybrid:recovery:test          App → Theme   mock_state      │
│  hybrid:theme:tokens_read      Theme → App   root_css_vars   │
│  hybrid:theme:section_mounted  Theme → App   section_id      │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Bundle Engine — Logic Flow

### 4.1 Architecture Overview

The bundle engine uses Shopify Functions exclusively — no draft orders, no client-side price calculation, no hidden line items. Two functions work in tandem:

- `hybrid-bundle-validate` — Cart/Checkout Validation Function
- `hybrid-bundle-discount` — Discount Function (Order Discount type)

### 4.2 Double-Discount Prevention Logic

The critical invariant: a bundle discount must never stack with an incompatible automatic discount or discount code. The system uses a three-phase evaluation.

```
PHASE 1: CART COMPOSITION ANALYSIS
───────────────────────────────────
Input:  cart.lines[], shop.metafields["hybrid.bundle_config"]
Output: qualified_bundles[], non_bundle_items[]

FOR each bundle_config IN active_bundles:
    matched_lines = []
    FOR each cart_line IN cart.lines:
        IF cart_line.product_id IN bundle_config.components
           AND cart_line.quantity >= component.quantity_min:
            matched_lines.APPEND(cart_line)
    
    IF matched_lines satisfies ALL required components:
        qualified_bundles.APPEND({
            bundle_id:   bundle_config.bundle_id,
            lines:       matched_lines,
            discount:    bundle_config.pricing,
            stacking:    bundle_config.pricing.stacking_policy
        })

PHASE 2: DISCOUNT CONFLICT RESOLUTION
──────────────────────────────────────
Input:  qualified_bundles[], existing_discounts[]
Output: approved_discounts[]

FOR each bundle IN qualified_bundles:
    conflicts = []
    
    FOR each existing_discount IN cart.discount_allocations:
        IF existing_discount.code IN bundle.metadata.discount_code_exclusions:
            conflicts.APPEND(existing_discount)
        IF existing_discount.code MATCHES bundle.metadata.discount_code_exclusions (glob):
            conflicts.APPEND(existing_discount)
    
    SWITCH bundle.stacking_policy:
        CASE "exclusive":
            // Bundle discount wins; reject all conflicting codes
            IF conflicts.LENGTH > 0:
                approved_discounts.APPEND(bundle.discount)
                rejected_codes.APPEND(conflicts)
            ELSE:
                approved_discounts.APPEND(bundle.discount)
        
        CASE "best_price":
            // Compare: which gives the customer a better deal?
            bundle_savings    = calculate_savings(bundle.discount, bundle.lines)
            code_savings      = SUM(conflicts.map(c => c.allocated_amount))
            
            IF bundle_savings >= code_savings:
                approved_discounts.APPEND(bundle.discount)
                rejected_codes.APPEND(conflicts)
            ELSE:
                // Let the discount code win; skip bundle discount
                SKIP bundle
        
        CASE "stackable":
            // Both apply; but cap total discount at line item cost
            combined = bundle.discount.value + SUM(conflicts.map(c => c.value))
            IF combined > MAX_DISCOUNT_PERCENTAGE (e.g., 50%):
                // Cap the bundle discount to stay within threshold
                bundle.discount.value = MAX_DISCOUNT_PERCENTAGE - code_savings_pct
            approved_discounts.APPEND(bundle.discount)

PHASE 3: FUNCTION OUTPUT
────────────────────────
Input:  approved_discounts[], rejected_codes[]
Output: FunctionResult

// Discount Function returns:
RETURN {
    discountApplicationStrategy: "MAXIMUM",
    discounts: approved_discounts.MAP(d => ({
        value: { percentage: d.value },
        targets: d.lines.MAP(line => ({
            productVariant: { id: line.variant_id }
        })),
        message: "Bundle savings applied"
    }))
}

// Validation Function returns (if codes must be rejected):
IF rejected_codes.LENGTH > 0:
    RETURN {
        errors: rejected_codes.MAP(code => ({
            localizedMessage: "Code '{code}' cannot combine with bundle pricing",
            target: "$.cart.discountCodes"
        }))
    }
```

### 4.3 Inventory Management

Bundles do NOT create synthetic products or draft orders. Each bundle component remains an independent variant in Shopify's inventory system.

```
INVENTORY FLOW
──────────────
1. Customer adds bundle to cart
   → Each component is a separate cart line
   → Inventory reservations happen at variant level (Shopify native)

2. Checkout completes
   → Each variant decrements independently
   → No ghost SKUs, no draft order cleanup

3. Bundle metadata stored as order metafield
   → Allows fulfillment team to pick/pack as a unit
   → Returns can be processed per-component

EDGE CASE: Partial stock
   IF any bundle component variant.inventory_quantity < required_quantity:
       Validation Function returns error:
       "Bundle unavailable — {component_title} is out of stock"
       → Cart page shows inline error via theme section
```

---

## 5. Unified UI Protocol

### 5.1 CSS Variable Inheritance Chain

The system ensures every app-injected component looks native to the theme without any CSS file injection.

```
INHERITANCE CHAIN
─────────────────

LAYER 1: Theme :root (source of truth)
    :root {
        --color-primary: #2a2a2a;
        --color-accent: #c8102e;
        --font-body: "Avenir Next", sans-serif;
        --font-heading: "Playfair Display", serif;
        --border-radius: 4px;
        --spacing-unit: 8px;
    }

LAYER 2: Hybrid Bridge Variables (auto-mapped)
    :root {
        /* These are generated by the theme's hybrid-bridge snippet */
        --hybrid-bg:       var(--color-background);
        --hybrid-text:     var(--color-primary);
        --hybrid-accent:   var(--color-accent);
        --hybrid-font:     var(--font-body);
        --hybrid-heading:  var(--font-heading);
        --hybrid-radius:   var(--border-radius);
        --hybrid-spacing:  var(--spacing-unit);
    }

LAYER 3: Component-Specific Overrides (from ui_protocol metafield)
    /* Only applied when merchant explicitly sets a value in App admin */
    hybrid-upsell {
        --hybrid-upsell-bg:     var(--hybrid-bg);
        --hybrid-upsell-radius: var(--hybrid-radius);
        --hybrid-upsell-shadow: 0 -4px 24px rgba(0,0,0,0.08);
    }
```

### 5.2 Web Component Architecture

Each feature renders as a native Web Component. The theme defines the shell; the component's internal DOM reads from Metafield-populated data attributes.

```
COMPONENT REGISTRATION
──────────────────────

File: assets/hybrid-components.js (bundled with theme, <2KB gzipped)

class HybridUpsell extends HTMLElement {
    // Shadow DOM with :host inheriting from --hybrid-* variables
    // Reads product data from data-upsell-rules attribute
    // Populated by Liquid from hybrid.upsell_rules metafield
    
    connectedCallback():
        this.rules = JSON.parse(this.dataset.upsellRules)
        this.attachShadow({ mode: 'open' })
        this.render()
    
    render():
        // All styles reference --hybrid-* CSS variables
        // Zero external stylesheets
        // Slot-based composition for theme-provided content
}

class HybridSizeChart extends HTMLElement {
    // Modal overlay using <dialog> element
    // Data from hybrid.size_chart product metafield
    // Inherits theme typography and colors
}

class HybridWelcomeBack extends HTMLElement {
    // Conditional render based on hybrid.visitor_state
    // Appears only for returning visitors with abandoned carts
    // Reads recovery_stage to determine message intensity
}

// Registration (deferred, non-blocking)
if (!customElements.get('hybrid-upsell'))
    customElements.define('hybrid-upsell', HybridUpsell)
if (!customElements.get('hybrid-size-chart'))
    customElements.define('hybrid-size-chart', HybridSizeChart)
if (!customElements.get('hybrid-welcome-back'))
    customElements.define('hybrid-welcome-back', HybridWelcomeBack)
```

### 5.3 Liquid Integration Pattern

```liquid
{% comment %} sections/hybrid-upsell.liquid {% endcomment %}

{%- assign upsell_data = product.metafields.hybrid.upsell_rules.value -%}
{%- if upsell_data != blank -%}
  <hybrid-upsell
    data-upsell-rules='{{ upsell_data | json }}'
    data-product-id="{{ product.id }}"
    data-cart-token="{{ cart.token }}"
    style="
      --hybrid-upsell-bg: var(--hybrid-bg);
      --hybrid-upsell-text: var(--hybrid-text);
    "
  >
    <noscript>
      {%- comment -%} Fallback: render upsell as static Liquid {%- endcomment -%}
      {%- for rule in upsell_data.rules -%}
        <div class="hybrid-upsell__item--static">
          {{ rule.title }}
        </div>
      {%- endfor -%}
    </noscript>
  </hybrid-upsell>
{%- endif -%}

{% schema %}
{
  "name": "Hybrid Upsell",
  "target": "section",
  "settings": [
    {
      "type": "checkbox",
      "id": "show_upsell",
      "label": "Show upsell suggestions",
      "default": true
    }
  ],
  "presets": [
    { "name": "Hybrid Upsell" }
  ]
}
{% endschema %}
```

---

## 6. Contextual Recovery Flow

### 6.1 Event Ingestion Pipeline

```
EVENT PIPELINE
──────────────

STOREFRONT EVENTS (collected via Web Pixel API — no custom JS):
    ┌──────────────────────┐
    │  page_viewed          │───┐
    │  product_viewed       │   │
    │  collection_viewed    │   ├──▶ Shopify Web Pixel
    │  cart_updated         │   │    (server-side, no DOM access)
    │  checkout_started     │   │
    │  checkout_completed   │───┘
    └──────────────────────┘
              │
              ▼
    ┌──────────────────────┐
    │  App Event Processor  │
    │  (webhook endpoint)   │
    │                       │
    │  1. Deduplicate        │
    │  2. Sessionize         │
    │  3. Score intent       │
    │  4. Update metafield   │
    └──────────────────────┘
              │
              ▼
    ┌──────────────────────┐
    │  customer.metafields   │
    │  hybrid.visitor_state  │
    │                       │
    │  Written via Admin API │
    │  Read by Theme Liquid  │
    └──────────────────────┘
```

### 6.2 Recovery Stage State Machine

```
STATE MACHINE: recovery_stage
─────────────────────────────

                    cart_updated (items added)
    [no_cart] ──────────────────────────────────▶ [active_cart]
        ▲                                              │
        │ checkout_completed                           │ no activity
        │                                              │ for 30 min
    [converted] ◀── checkout_completed ── [recovered]  │
                                              ▲        ▼
                                              │   [soft_nudge]
                                              │        │
                                     click    │        │ +24 hours
                                     recovery │        │ no activity
                                     link     │        ▼
                                              │   [incentive]
                                              │        │
                                              │        │ +48 hours
                                              │        │ no activity
                                              │        ▼
                                              │   [final_reminder]
                                              │        │
                                              └────────┘
                                                       │
                                                       │ +7 days no activity
                                                       ▼
                                                  [expired]
```

### 6.3 Theme-Side Recovery Rendering

```
RECOVERY RENDERING LOGIC (Liquid + Web Component)
──────────────────────────────────────────────────

{% comment %} layout/theme.liquid — early in <body> {% endcomment %}

{%- if customer -%}
  {%- assign visitor = customer.metafields.hybrid.visitor_state.value -%}
  {%- if visitor and visitor.flags.is_returning and visitor.flags.has_abandoned_cart -%}
    
    <hybrid-welcome-back
      data-stage="{{ visitor.abandoned_cart.recovery_stage }}"
      data-cart-items='{{ visitor.abandoned_cart.items | json }}'
      data-customer-name="{{ customer.first_name | escape }}"
      data-discount-code="{{ visitor.abandoned_cart.recovery_discount_code }}"
      data-visit-count="{{ visitor.browse_history.visit_count_last_30d }}"
    >
    </hybrid-welcome-back>

  {%- endif -%}
{%- endif -%}

WEB COMPONENT RENDER LOGIC (pseudo-code):
─────────────────────────────────────────
connectedCallback():
    stage = this.dataset.stage
    
    SWITCH stage:
        CASE "soft_nudge":
            // Subtle banner: "Welcome back, {name}! Your cart is waiting."
            // Shows cart item thumbnails
            // CTA: "View your cart"
            this.renderBanner({
                tone: "warm",
                show_items: true,
                cta: "Continue shopping"
            })
        
        CASE "incentive":
            // Slightly more prominent banner with incentive
            // "Still thinking it over? Here's 10% off your cart."
            // Shows discount code if available
            this.renderBanner({
                tone: "encouraging",
                show_items: true,
                show_discount: this.dataset.discountCode != null,
                cta: "Claim your discount"
            })
        
        CASE "final_reminder":
            // Full-width gentle reminder
            // "Your items are selling fast — don't miss out."
            // Urgency without desperation
            this.renderBanner({
                tone: "urgent_gentle",
                show_items: true,
                show_discount: true,
                show_stock_hint: true,
                cta: "Complete your order"
            })
        
        CASE "expired":
            // No render — visitor state is stale
            this.remove()
```

---

## 7. Performance Strategy

### 7.1 Performance Budget

| Metric | Target | Enforcement |
|--------|--------|-------------|
| Lighthouse Performance | 95+ | CI gate on theme deploy |
| Total JS payload (theme + hybrid) | < 15KB gzipped | Build-time check |
| External JS libraries | 0 | Lint rule (no import from CDN) |
| Web Components registration | < 2KB gzipped | Bundle analysis |
| Largest Contentful Paint | < 1.2s | Real User Monitoring |
| Cumulative Layout Shift | < 0.05 | Skeleton slots in Liquid |
| Total Blocking Time | < 100ms | No synchronous Metafield parsing |

### 7.2 Zero External Dependencies Strategy

```
DEPENDENCY MAP
──────────────
                                                    
  ┌─────────────────────────────────────────────┐
  │              STOREFRONT                      │
  │                                              │
  │  JS Dependencies:    NONE external           │
  │  CSS Dependencies:   NONE external           │
  │  Font Loading:       theme-native only       │
  │                                              │
  │  Hybrid Components:                          │
  │    hybrid-components.js  — 1.8KB gzipped     │
  │    (Web Components, no framework)            │
  │    (loaded via <script type="module" async>) │
  │                                              │
  │  Rendering:                                  │
  │    Liquid SSR → HTML                         │
  │    Web Components → Shadow DOM enhancement   │
  │    CSS Variables → zero-cost inheritance      │
  │                                              │
  │  BANNED:                                     │
  │    ✗ jQuery                                  │
  │    ✗ React/Vue/Svelte on storefront          │
  │    ✗ Tailwind runtime                        │
  │    ✗ Third-party analytics scripts           │
  │    ✗ External font CDNs                      │
  │    ✗ Polyfills (Web Components baseline)     │
  └─────────────────────────────────────────────┘
```

### 7.3 Loading Strategy

```
LOADING WATERFALL
─────────────────

1. HTML (Liquid SSR)
   ├── All content rendered server-side
   ├── Metafield data injected as data-* attributes
   ├── CSS variables set in <style> block from ui_protocol metafield
   └── Skeleton placeholders for Web Component slots

2. CSS (theme stylesheet)
   ├── Single concatenated file, preloaded
   ├── Contains --hybrid-* variable declarations
   └── No @import chains

3. JS (deferred, non-blocking)
   ├── <script type="module" async src="hybrid-components.js">
   ├── Components self-register on parse
   ├── Progressive enhancement: content visible before JS
   └── IntersectionObserver for below-fold components
       (only initialize when entering viewport)

4. Images (lazy-loaded)
   ├── Native loading="lazy" on all below-fold images
   ├── Shopify CDN image transforms (webp, size params)
   └── Explicit width/height attributes (CLS prevention)
```

### 7.4 Metafield Read Optimization

```
METAFIELD CACHING STRATEGY
───────────────────────────

PROBLEM: Reading 6 metafields per page load adds latency.

SOLUTION: Liquid-level aggregation.

File: snippets/hybrid-data-bridge.liquid

{% comment %}
  Single Liquid snippet included once in layout/theme.liquid.
  Reads ALL hybrid metafields and outputs them as a single
  JSON object in a <script type="application/json"> tag.
  Web Components read from this cached DOM node instead of
  individual data attributes.
{% endcomment %}

<script type="application/json" id="hybrid-data">
{
  "bundle": {{ product.metafields.hybrid.bundle_config | json }},
  "upsell": {{ product.metafields.hybrid.upsell_rules | json }},
  "size_chart": {{ product.metafields.hybrid.size_chart | json }},
  "ui_protocol": {{ shop.metafields.hybrid.ui_protocol | json }},
  "visitor": {% if customer %}{{ customer.metafields.hybrid.visitor_state | json }}{% else %}null{% endif %},
  "page_type": "{{ request.page_type }}",
  "product_id": {% if product %}"{{ product.id }}"{% else %}null{% endif %}
}
</script>

COMPONENT READ PATTERN:
    // Parsed once, shared across all components
    const HYBRID_DATA = JSON.parse(
        document.getElementById('hybrid-data')?.textContent || '{}'
    )
    // Each component reads its slice — no re-parsing
```

---

## 8. API Endpoint Strategy

### 8.1 App Backend Endpoints

```
BASE URL: https://app.hybridcommerce.io/api/v1

AUTHENTICATION: Shopify session token (App Bridge v4)
                All requests include X-Shopify-Shop-Domain header

┌────────────────────────────────────────────────────────────────────────┐
│  ENDPOINT                          METHOD  PURPOSE                    │
├────────────────────────────────────────────────────────────────────────┤
│  /bundles                          GET     List all bundle configs    │
│  /bundles                          POST    Create new bundle          │
│  /bundles/:id                      PUT     Update bundle config       │
│  /bundles/:id                      DELETE  Remove bundle              │
│  /bundles/:id/preview              POST    Generate preview payload   │
│                                            (sends App Bridge event)   │
│                                                                       │
│  /upsells/rules                    GET     List upsell rules          │
│  /upsells/rules                    POST    Create upsell rule         │
│  /upsells/rules/:id                PUT     Update rule                │
│                                                                       │
│  /size-charts                      GET     List size charts           │
│  /size-charts                      POST    Create chart               │
│  /size-charts/:id/assign           POST    Assign to product(s)       │
│                                                                       │
│  /recovery/config                  GET     Get recovery settings      │
│  /recovery/config                  PUT     Update settings            │
│  /recovery/stats                   GET     Dashboard metrics          │
│                                                                       │
│  /ui-protocol                      GET     Current UI protocol        │
│  /ui-protocol                      PUT     Update overrides           │
│  /ui-protocol/sync                 POST    Re-read theme :root vars   │
│                                            (triggers theme token scan) │
│                                                                       │
│  /webhooks/cart-update             POST    Shopify webhook receiver    │
│  /webhooks/order-create            POST    Shopify webhook receiver    │
│  /webhooks/customer-update         POST    Shopify webhook receiver    │
│  /webhooks/pixel-events            POST    Web Pixel event receiver    │
└────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Metafield Write Flow

```
METAFIELD SYNC PROTOCOL
────────────────────────

When a merchant saves a bundle configuration in the App admin:

1. App validates bundle config against schema
2. App writes to product metafield via Admin GraphQL API:

    mutation MetafieldSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key }
        userErrors { field message }
      }
    }

    variables: {
      metafields: [{
        ownerId: "gid://shopify/Product/123",
        namespace: "hybrid",
        key: "bundle_config",
        type: "json",
        value: JSON.stringify(bundleConfig)
      }]
    }

3. App deploys/updates Shopify Function with new discount logic
4. App sends App Bridge event for live preview in theme editor
5. Theme reads updated metafield on next page load (no cache bust needed;
   Liquid reads are always fresh)
```

### 8.3 Shopify Functions Deployment

```
FUNCTION MANIFEST
─────────────────

Extension: hybrid-bundle-discount
Type:      product_discounts
Runtime:   Wasm (Rust compiled, <256KB)
Input:     cart lines, discount codes, metafields
Output:    discount allocations

Extension: hybrid-bundle-validate  
Type:      cart_checkout_validation
Runtime:   Wasm (Rust compiled, <256KB)
Input:     cart lines, metafields
Output:    validation errors (if double-discount detected)

DEPLOYMENT:
    shopify app deploy
    → Compiles Rust to Wasm
    → Uploads to Shopify Functions runtime
    → Associated with app installation
    → Executes server-side at checkout (zero client JS)
```

---

## 9. Security Considerations

- **Metafield Access Control:** All hybrid metafields are app-owned (read-only from Liquid, write-only from authenticated App). Merchants cannot manually edit raw JSON.
- **Visitor State Privacy:** Customer metafields containing browse history are scoped to the shop's own customer records. No cross-shop tracking. Data expires after 30 days of inactivity (TTL enforced by the App's cleanup cron).
- **Discount Function Integrity:** Bundle discount logic runs server-side in Shopify's Wasm sandbox. No client-side price manipulation is possible. The validation function acts as a second check against the discount function's output.
- **App Bridge Authentication:** All admin API calls use Shopify session tokens with HMAC validation. No API keys stored client-side.
- **Web Component XSS Prevention:** All Metafield data is parsed as JSON (not interpolated as HTML). Shadow DOM encapsulation prevents style injection from malicious metafield content.

---

## 10. Deployment and Testing Strategy

### 10.1 CI Pipeline

```
PIPELINE STAGES
───────────────

1. LINT
   ├── Theme Liquid: theme-check (Shopify CLI)
   ├── JS: ESLint (no-external-import rule)
   ├── CSS: Stylelint (no-external-url rule)
   └── Metafield schemas: JSON Schema validation

2. BUILD
   ├── Theme: Shopify CLI theme package
   ├── App: Node.js build + Rust Wasm compile
   └── Functions: cargo build --target wasm32-unknown-unknown

3. TEST
   ├── Unit: Vitest for Web Components
   ├── Integration: Playwright for storefront rendering
   ├── Performance: Lighthouse CI (score >= 95 gate)
   ├── Function: shopify app function test (Wasm unit tests)
   └── Double-discount: parametric test suite
        (100+ combinations of codes × bundles × stacking policies)

4. DEPLOY
   ├── Theme: shopify theme push (staging → production)
   ├── App: Fly.io deploy (blue/green)
   └── Functions: shopify app deploy
```

---

*End of Architecture Document*
