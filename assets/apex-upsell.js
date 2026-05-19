// =============================================================================
// Apex Upsell — shared storefront module
// -----------------------------------------------------------------------------
// One custom element (<apex-upsell>) used across three placements:
//   * cart drawer  — sticky widget while the drawer is open
//   * cart page    — block inside the /cart template
//   * product page — "frequently bought together" on PDP
//
// Each placement just drops the element with different dataset attrs. No
// duplicate code, no theme coupling, no global mutation beyond a tiny bus
// (window.ApexBus) and a cart snapshot cache (window.ApexCartState).
//
// Server contract (App Proxy):
//   POST /apps/hybrid/recommendations  -> { recommendations: [...] }
//   POST /apps/hybrid/events           -> { event: 'impression' | 'click' }
//
// Analytics:
//   * impression beacon fired once per (element, product_id)
//   * click beacon fired on add-to-cart
//   * line item tagged with `_hybrid_rec` for exact conversion attribution
// =============================================================================
(() => {
  // ── Tiny pub/sub so the cart drawer and the page widgets can coordinate ──
  if (!window.ApexBus) {
    const listeners = {};
    window.ApexBus = {
      on(event, handler) {
        (listeners[event] ||= []).push(handler);
      },
      emit(event, detail) {
        (listeners[event] || []).forEach((h) => { try { h(detail); } catch (_) { /* swallow */ } });
      },
    };
  }

  // ── Shopify cart API wrapper ───────────────────────────────────────────
  const cartApi = window.ApexCartApi || (window.ApexCartApi = {
    async fetchCart() {
      const res = await fetch('/cart.js', { credentials: 'same-origin' });
      return res.json();
    },
    async addItem(variantId, quantity, properties) {
      const body = { id: variantId, quantity };
      if (properties && Object.keys(properties).length > 0) body.properties = properties;
      const res = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      return res.json();
    },
  });

  // ── Money formatting (defers to Shopify's helper when the theme loads it) ─
  const formatMoney = (cents, currencySymbol) => {
    if (window.Shopify && typeof window.Shopify.formatMoney === 'function') {
      return window.Shopify.formatMoney(cents);
    }
    return `${currencySymbol || ''}${(cents / 100).toFixed(2)}`;
  };

  // ── Beacons — fire-and-forget. sendBeacon survives navigation; falls back ─
  // ── to fetch keepalive. URL is signed by Shopify's App Proxy on the way in.
  const fireBeacon = (endpoint, payload) => {
    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(endpoint, blob)) return;
      }
    } catch (_) { /* fall through */ }
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body,
    }).catch(() => {});
  };

  // ── Ghost discount preview (display-only; real discount is applied by ────
  // ── Shopify Functions at checkout, not by client-side math). ─────────────
  const applyGhostDiscount = (basePriceCents, discount) => {
    if (!discount || !discount.type || !discount.value) return basePriceCents;
    const value = Number(discount.value);
    if (discount.type === 'percentage')   return Math.max(0, Math.round(basePriceCents * (1 - value / 100)));
    if (discount.type === 'fixed_amount') return Math.max(0, basePriceCents - Math.round(value * 100));
    if (discount.type === 'fixed_price')  return Math.max(0, Math.round(value * 100));
    return basePriceCents;
  };

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

  // ──────────────────────────────────────────────────────────────────────────
  // <apex-upsell>
  // ──────────────────────────────────────────────────────────────────────────
  // dataset attrs (all optional):
  //   data-recommendations-endpoint  default: /apps/hybrid/recommendations
  //   data-events-endpoint           default: /apps/hybrid/events
  //   data-placement                 cart-drawer | cart | product   default: cart
  //   data-anchor-product-id         (product page) the PDP product id
  //   data-limit                     max recs to render             default: 1
  //   data-heading                   title text
  //   data-subheading                supporting copy
  //   data-add-label                 button label                   default: Add
  //   data-currency                  fallback currency symbol
  //   data-candidates                JSON array of fallback product handles
  // ──────────────────────────────────────────────────────────────────────────
  class ApexUpsell extends HTMLElement {
    async connectedCallback() {
      this.recEndpoint = this.dataset.recommendationsEndpoint || '/apps/hybrid/recommendations';
      this.eventsEndpoint = this.dataset.eventsEndpoint || '/apps/hybrid/events';
      this.placement = this.dataset.placement || 'cart';
      this.anchorProductId = this.dataset.anchorProductId ? Number(this.dataset.anchorProductId) : null;
      this.limit = Math.min(Math.max(parseInt(this.dataset.limit, 10) || 1, 1), 6);
      this.heading = this.dataset.heading || 'You might also like';
      this.subheading = this.dataset.subheading || '';
      this.addLabel = this.dataset.addLabel || 'Add';
      this.currencySymbol = this.dataset.currency || '';
      this.fallbackHandles = (() => {
        try { return JSON.parse(this.dataset.candidates || '[]'); } catch (_) { return []; }
      })();

      this._beaconedIds = new Set();
      this.attachShadow({ mode: 'open' });
      this.style.display = 'block';

      this._onCartChange = () => this.refresh();
      window.ApexBus.on('cart:render', this._onCartChange);

      await this.refresh();
    }

    disconnectedCallback() {
      // Custom elements may be re-attached after section re-renders — leave
      // the bus listener; ApexBus is bounded and emit() is idempotent.
    }

    async refresh() {
      let cart = window.ApexCartState;
      if (!cart) {
        cart = await cartApi.fetchCart().catch(() => ({ items: [], currency: '' }));
        window.ApexCartState = cart;
      }

      const recs = await this.resolveRecommendations(cart);
      if (!recs || recs.length === 0) {
        this.shadowRoot.replaceChildren();
        this.style.display = 'none';
        return;
      }

      this.style.display = 'block';
      this.render(recs);

      // Fire impressions for any product we haven't beaconed for from this
      // element instance.
      const newIds = recs
        .map((r) => Number(r.product_id))
        .filter((id) => Number.isFinite(id) && !this._beaconedIds.has(id));
      if (newIds.length > 0) {
        newIds.forEach((id) => this._beaconedIds.add(id));
        fireBeacon(this.eventsEndpoint, { event: 'impression', product_ids: newIds });
      }
    }

    async resolveRecommendations(cart) {
      const excludeIds = (cart.items || []).map((i) => i.product_id).filter(Boolean);

      // PDP: pre-seed the request with the anchor product so the engine can
      // recommend complements even when the cart is empty.
      const cartItems = [
        ...(this.anchorProductId ? [{ product_id: this.anchorProductId, quantity: 1 }] : []),
        ...(cart.items || []).map((i) => ({
          product_id: i.product_id,
          variant_id: i.variant_id,
          quantity: i.quantity,
        })),
      ];

      // For cart-drawer / cart placements, hide entirely when cart is empty.
      if (this.placement !== 'product' && cartItems.length === 0) return [];

      let recs = [];
      try {
        const res = await fetch(this.recEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            cart_items: cartItems,
            current_product_id: this.anchorProductId || undefined,
            limit: this.limit,
            exclude_product_ids: excludeIds.concat(this.anchorProductId ? [this.anchorProductId] : []),
            locale: document.documentElement.lang || 'en',
          }),
        });
        if (res.ok) {
          const payload = await res.json();
          recs = Array.isArray(payload?.recommendations) ? payload.recommendations : [];
        }
      } catch (_) { /* fall through to candidates */ }

      // Strip anything already in cart (defence-in-depth — server should too).
      recs = recs.filter((r) => r.variant_id && !excludeIds.includes(r.product_id));
      if (recs.length >= this.limit) return recs.slice(0, this.limit);

      // Fallback: merchant-curated candidate handles (only used for the cart
      // drawer where the section pushes them in via data-candidates).
      const need = this.limit - recs.length;
      if (need > 0 && this.fallbackHandles.length > 0) {
        for (const handle of this.fallbackHandles) {
          if (recs.length >= this.limit) break;
          const product = await this.fetchProductByHandle(handle);
          if (!product) continue;
          if (excludeIds.includes(product.id)) continue;
          recs.push({
            product_id: product.id,
            variant_id: product.variants?.[0]?.id,
            handle: product.handle,
            title: product.title,
            image_url: product.featured_image,
            price_cents: product.price,
            available: product.available,
            discount: null,
          });
        }
      }

      return recs;
    }

    async fetchProductByHandle(handle) {
      try {
        const res = await fetch(`/products/${handle}.js`, { credentials: 'same-origin' });
        if (!res.ok) return null;
        return res.json();
      } catch (_) { return null; }
    }

    render(recs) {
      const layout = this.placement === 'product' ? 'grid' : 'list';
      const cardsHtml = recs.map((r) => this.renderCard(r)).join('');
      this.shadowRoot.innerHTML = `
        <style>${this.css()}</style>
        <section class="upsell" part="upsell" data-placement="${this.placement}" data-layout="${layout}">
          <header class="upsell-head">
            <h3 class="heading">${escapeHtml(this.heading)}</h3>
            ${this.subheading ? `<p class="subheading">${escapeHtml(this.subheading)}</p>` : ''}
          </header>
          <div class="cards ${layout === 'grid' ? 'cards--grid' : 'cards--list'}">
            ${cardsHtml}
          </div>
        </section>
      `;

      // Wire add buttons. One listener per card; targeting via data-pid so
      // we don't need to keep references to elements.
      this.shadowRoot.querySelectorAll('[data-add]').forEach((btn) => {
        btn.addEventListener('click', () => this.handleAdd(btn.dataset.pid, btn));
      });
    }

    renderCard(r) {
      const base = Number(r.price_cents || 0);
      const discounted = applyGhostDiscount(base, r.discount);
      const priceHtml = discounted !== base
        ? `<span class="price price--discounted">${formatMoney(discounted, this.currencySymbol)}</span>
           <span class="price price--compare">${formatMoney(base, this.currencySymbol)}</span>`
        : `<span class="price">${formatMoney(base, this.currencySymbol)}</span>`;
      const badgeHtml = r.discount && r.discount.label
        ? `<span class="badge">${escapeHtml(r.discount.label)}</span>`
        : '';
      const imgUrl = r.image_url || '';
      return `
        <article class="card">
          <div class="thumb">
            ${imgUrl ? `<img loading="lazy" src="${escapeHtml(imgUrl)}" alt="${escapeHtml(r.title || '')}">` : ''}
            ${badgeHtml}
          </div>
          <div class="meta">
            <p class="title">${escapeHtml(r.title || '')}</p>
            <div class="price-row">${priceHtml}</div>
          </div>
          <button class="btn" type="button" data-add data-pid="${r.product_id}" data-vid="${r.variant_id}" aria-label="Add ${escapeHtml(r.title || '')} to cart">
            ${escapeHtml(this.addLabel)}
          </button>
        </article>
      `;
    }

    async handleAdd(productId, btn) {
      const variantId = btn?.dataset.vid;
      if (!variantId) return;
      btn.disabled = true;
      const originalLabel = btn.textContent;
      btn.textContent = 'Adding…';
      try {
        fireBeacon(this.eventsEndpoint, { event: 'click', product_id: Number(productId) });
        await cartApi.addItem(Number(variantId), 1, { _hybrid_rec: String(productId) });
        const updatedCart = await cartApi.fetchCart();
        window.ApexCartState = updatedCart;
        window.ApexBus.emit('cart:render', { cart: updatedCart });
        btn.textContent = 'Added ✓';
        setTimeout(() => { btn.textContent = originalLabel; btn.disabled = false; }, 1200);
      } catch (err) {
        btn.textContent = originalLabel;
        btn.disabled = false;
      }
    }

    // Theme-neutral CSS that leans on CSS variables so merchants can tune the
    // look without editing this file.
    css() {
      return `
        :host {
          --apex-bg:        var(--apex-upsell-bg, #fafafa);
          --apex-fg:        var(--apex-upsell-fg, #0a0a0a);
          --apex-muted:     var(--apex-upsell-muted, #737373);
          --apex-line:      var(--apex-upsell-line, #e5e5e5);
          --apex-btn-bg:    var(--apex-upsell-btn-bg, #0a0a0a);
          --apex-btn-fg:    var(--apex-upsell-btn-fg, #ffffff);
          --apex-radius:    var(--apex-upsell-radius, 10px);
          --apex-font:      var(--apex-upsell-font, inherit);
          display: block;
          color: var(--apex-fg);
          font-family: var(--apex-font);
          line-height: 1.4;
        }
        * { box-sizing: border-box; }
        .upsell {
          background: var(--apex-bg);
          border: 1px solid var(--apex-line);
          border-radius: var(--apex-radius);
          padding: 16px;
        }
        .upsell-head { margin-bottom: 12px; }
        .heading { margin: 0 0 2px; font-size: 15px; font-weight: 600; letter-spacing: -0.005em; }
        .subheading { margin: 0; font-size: 13px; color: var(--apex-muted); }
        .cards.cards--list { display: flex; flex-direction: column; gap: 10px; }
        .cards.cards--grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
        .card {
          display: grid;
          grid-template-columns: 64px 1fr auto;
          align-items: center;
          gap: 12px;
          background: #fff;
          border: 1px solid var(--apex-line);
          border-radius: 8px;
          padding: 10px;
        }
        .cards--grid .card { grid-template-columns: 1fr; text-align: left; }
        .thumb {
          position: relative;
          width: 64px; height: 64px;
          background: #f0f0f0;
          border-radius: 6px;
          overflow: hidden;
        }
        .cards--grid .thumb { width: 100%; aspect-ratio: 1 / 1; height: auto; }
        .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .badge {
          position: absolute;
          top: 4px; left: 4px;
          background: var(--apex-fg);
          color: var(--apex-btn-fg);
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 4px;
          letter-spacing: 0.02em;
        }
        .meta { min-width: 0; }
        .title {
          margin: 0 0 4px;
          font-size: 13px;
          font-weight: 500;
          color: var(--apex-fg);
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .price-row { display: flex; gap: 6px; align-items: baseline; font-size: 13px; }
        .price--compare { color: var(--apex-muted); text-decoration: line-through; }
        .price--discounted { color: var(--apex-fg); font-weight: 600; }
        .btn {
          appearance: none;
          background: var(--apex-btn-bg);
          color: var(--apex-btn-fg);
          border: 0;
          border-radius: 999px;
          padding: 8px 14px;
          font: inherit;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
          transition: opacity 0.15s, transform 0.05s;
        }
        .btn:hover { opacity: 0.9; }
        .btn:active { transform: translateY(1px); }
        .btn:disabled { opacity: 0.6; cursor: default; transform: none; }
        .cards--grid .btn { width: 100%; margin-top: 8px; }
        @media (prefers-reduced-motion: reduce) {
          .btn { transition: none; }
        }
      `;
    }
  }

  if (!customElements.get('apex-upsell')) {
    customElements.define('apex-upsell', ApexUpsell);
  }
})();
