(() => {
  const bus = (() => {
    const listeners = {};
    return {
      on(event, handler) {
        listeners[event] = listeners[event] || [];
        listeners[event].push(handler);
      },
      emit(event, detail) {
        (listeners[event] || []).forEach((handler) => handler(detail));
      }
    };
  })();

  if (!window.ApexBus) {
    window.ApexBus = bus;
  }

  const cartApi = {
    async fetchCart() {
      const response = await fetch('/cart.js', { credentials: 'same-origin' });
      return response.json();
    },
    async changeLine(lineKey, quantity) {
      const response = await fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id: lineKey, quantity })
      });
      return response.json();
    },
    async addItem(variantId, quantity, properties) {
      const body = { id: variantId, quantity };
      if (properties && Object.keys(properties).length > 0) {
        // Shopify cart/add.js accepts line-item properties under "properties".
        // Property names starting with "_" are hidden from shoppers.
        body.properties = properties;
      }
      const response = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body)
      });
      return response.json();
    },
    async renderSection(sectionName) {
      const url = `${window.location.pathname}?sections=${sectionName}`;
      const response = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      return response.json();
    }
  };

  const formatMoney = (cents, currencySymbol) => {
    if (window.Shopify && typeof window.Shopify.formatMoney === 'function') {
      return window.Shopify.formatMoney(cents);
    }
    const amount = (cents / 100).toFixed(2);
    return `${currencySymbol || ''}${amount}`;
  };

  // -------------------------------------------------------------------------
  // Analytics beacons — fire-and-forget POSTs to the App Proxy. Shopify
  // signs the request as it proxies, so the backend can trust the shop.
  // sendBeacon is preferred when available so it survives page unload.
  // -------------------------------------------------------------------------
  const eventsEndpoint = () => {
    const drawer = document.querySelector('#ApexCartDrawer');
    return drawer?.dataset.eventsEndpoint || '/apps/hybrid/events';
  };

  const fireBeacon = (payload) => {
    const url = eventsEndpoint();
    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(url, blob)) return;
      }
    } catch (_) {
      // fall through to fetch
    }
    // keepalive lets the request survive a navigation, like sendBeacon.
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body
    }).catch(() => {});
  };

  const beaconImpression = (productIds) => {
    if (!Array.isArray(productIds) || productIds.length === 0) return;
    fireBeacon({ event: 'impression', product_ids: productIds.map(Number).filter(Number.isFinite) });
  };

  const beaconClick = (productId) => {
    const n = Number(productId);
    if (!Number.isFinite(n)) return;
    fireBeacon({ event: 'click', product_id: n });
  };

  const applyGhostDiscount = (basePriceCents, discount) => {
    if (!discount || !discount.type || !discount.value) {
      return basePriceCents;
    }
    const value = Number(discount.value);
    if (discount.type === 'percentage') {
      return Math.max(0, Math.round(basePriceCents * (1 - value / 100)));
    }
    if (discount.type === 'fixed_amount') {
      return Math.max(0, basePriceCents - Math.round(value * 100));
    }
    if (discount.type === 'fixed_price') {
      return Math.max(0, Math.round(value * 100));
    }
    return basePriceCents;
  };

  class UpsellProduct extends HTMLElement {
    async connectedCallback() {
      this.currencySymbol = this.dataset.currency || '';
      this.heading = this.dataset.heading || 'You might also like';
      this.subheading = this.dataset.subheading || '';
      this.addLabel = this.dataset.addLabel || 'Add';
      this.endpoint = this.closest('#ApexCartDrawer')?.dataset.recommendationsEndpoint || '/apps/hybrid/recommendations';
      this.candidates = this.closest('#ApexCartDrawer')?.dataset.upsellCandidates || '[]';
      await this.refresh();
    }

    async refresh() {
      const cart = window.ApexCartState || (await cartApi.fetchCart());
      window.ApexCartState = cart;

      const recommendation = await this.resolveRecommendation(cart);
      if (!recommendation) {
        this.style.display = 'none';
        if (this.shadowRoot) {
          this.shadowRoot.replaceChildren();
        }
        return;
      }

      if (this.isInCart(cart, recommendation)) {
        this.style.display = 'none';
        if (this.shadowRoot) {
          this.shadowRoot.replaceChildren();
        }
        return;
      }

      this.style.display = 'block';
      if (!this.shadowRoot) {
        this.attachShadow({ mode: 'open' });
      }

      const basePrice = Number(recommendation.price_cents || 0);
      const discounted = applyGhostDiscount(basePrice, recommendation.discount);
      const priceHtml = discounted !== basePrice
        ? `<span class="price price--discounted">${formatMoney(discounted, this.currencySymbol)}</span>
           <span class="price price--compare">${formatMoney(basePrice, this.currencySymbol)}</span>`
        : `<span class="price">${formatMoney(basePrice, this.currencySymbol)}</span>`;

      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            margin-top: 1.5rem;
          }
          .upsell {
            background: var(--hybrid-upsell-bg, var(--color-background, #f6f5f2));
            border-radius: var(--hybrid-upsell-radius, 12px);
            box-shadow: var(--hybrid-upsell-shadow, 0 8px 24px rgba(0,0,0,0.06));
            padding: 1.2rem;
          }
          .heading {
            font-family: var(--font-heading, serif);
            font-size: 1.1rem;
            letter-spacing: 0.02em;
            margin: 0 0 0.25rem 0;
            color: var(--color-primary, #111);
          }
          .subheading {
            font-family: var(--font-body, sans-serif);
            color: var(--color-foreground, #444);
            font-size: 0.9rem;
            margin: 0 0 1rem 0;
          }
          .content {
            display: grid;
            grid-template-columns: 72px 1fr auto;
            gap: 0.9rem;
            align-items: center;
          }
          .thumb {
            width: 72px;
            height: 72px;
            border-radius: 10px;
            overflow: hidden;
            background: #eee;
          }
          .thumb img {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
          .title {
            font-family: var(--font-body, sans-serif);
            font-size: 0.95rem;
            margin: 0 0 0.35rem 0;
            color: var(--color-primary, #111);
          }
          .price {
            font-family: var(--font-body, sans-serif);
            font-size: 0.9rem;
            color: var(--color-primary, #111);
          }
          .price--compare {
            margin-left: 0.4rem;
            color: #777;
            text-decoration: line-through;
          }
          .btn {
            font-family: var(--font-body, sans-serif);
            background: var(--color-button, #111);
            color: var(--color-button-text, #fff);
            border: none;
            border-radius: 999px;
            padding: 0.5rem 1rem;
            cursor: pointer;
            white-space: nowrap;
          }
        </style>
        <div class="upsell">
          <div class="heading">${this.heading}</div>
          ${this.subheading ? `<div class="subheading">${this.subheading}</div>` : ''}
          <div class="content">
            <div class="thumb">
              <img loading="lazy" src="${recommendation.image_url}" alt="${recommendation.title}">
            </div>
            <div>
              <p class="title">${recommendation.title}</p>
              ${priceHtml}
            </div>
            <button class="btn" data-upsell-add>${this.addLabel}</button>
          </div>
        </div>
      `;

      // Fire impression beacon once per unique recommendation render.
      const productId = recommendation.product_id;
      if (productId && this._lastBeaconProductId !== productId) {
        this._lastBeaconProductId = productId;
        beaconImpression([productId]);
      }

      const addButton = this.shadowRoot.querySelector('[data-upsell-add]');
      addButton.addEventListener('click', async () => {
        addButton.disabled = true;
        beaconClick(productId);
        // Tag the line item so the orders/create webhook can attribute the
        // conversion EXACTLY rather than by probabilistic recommended-set
        // membership.
        await cartApi.addItem(recommendation.variant_id, 1, {
          _hybrid_rec: String(productId),
        });
        const updatedCart = await cartApi.fetchCart();
        window.ApexCartState = updatedCart;
        window.ApexBus.emit('cart:render', { cart: updatedCart });
        addButton.disabled = false;
      });
    }

    async resolveRecommendation(cart) {
      const candidates = JSON.parse(this.candidates || '[]');
      const candidate = candidates.find((handle) => !this.isHandleInCart(cart, handle));
      if (candidate) {
        const product = await this.fetchProduct(candidate);
        if (product) {
          return {
            product_id: product.id,
            title: product.title,
            handle: product.handle,
            image_url: product.featured_image,
            price_cents: product.price,
            variant_id: product.variants?.[0]?.id,
            discount: null
          };
        }
      }

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          cart_items: cart.items.map((item) => ({
            product_id: item.product_id,
            variant_id: item.variant_id,
            quantity: item.quantity
          })),
          limit: 1,
          exclude_product_ids: cart.items.map((item) => item.product_id),
          locale: document.documentElement.lang || 'en'
        })
      });

      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      const recommendation = payload?.recommendations?.[0];
      if (!recommendation || !recommendation.variant_id) {
        return null;
      }

      return recommendation;
    }

    async fetchProduct(handle) {
      try {
        const response = await fetch(`/products/${handle}.js`, { credentials: 'same-origin' });
        if (!response.ok) {
          return null;
        }
        return response.json();
      } catch (error) {
        return null;
      }
    }

    isHandleInCart(cart, handle) {
      return cart.items.some((item) => item.handle === handle);
    }

    isInCart(cart, recommendation) {
      if (recommendation.variant_id) {
        return cart.items.some((item) => item.variant_id === recommendation.variant_id);
      }
      return false;
    }
  }

  if (!customElements.get('upsell-product')) {
    customElements.define('upsell-product', UpsellProduct);
  }

  const initDrawer = (drawer) => {
    if (!drawer) {
      return;
    }

    drawer.addEventListener('click', (event) => {
      const closeBtn = event.target.closest('[data-cart-close]');
      if (closeBtn) {
        drawer.classList.remove('is-open');
        return;
      }

      const qtyButton = event.target.closest('[data-qty-change]');
      if (qtyButton) {
        const delta = Number(qtyButton.dataset.qtyChange);
        const line = qtyButton.closest('[data-line-key]');
        const input = line?.querySelector('.apex-cart-drawer__qty-input');
        const current = Number(input?.value || 0);
        const next = Math.max(0, current + delta);
        if (input) {
          input.value = String(next);
        }
        window.ApexBus.emit('cart:request-update', { lineKey: line?.dataset.lineKey, quantity: next });
      }
    });

    drawer.addEventListener('change', (event) => {
      const input = event.target.closest('.apex-cart-drawer__qty-input');
      if (!input) {
        return;
      }
      const line = input.closest('[data-line-key]');
      const next = Math.max(0, Number(input.value || 0));
      window.ApexBus.emit('cart:request-update', { lineKey: line?.dataset.lineKey, quantity: next });
    });
  };

  const openDrawer = () => {
    const drawer = document.querySelector('#ApexCartDrawer');
    if (drawer) {
      drawer.classList.add('is-open');
    }
  };

  const renderDrawer = async () => {
    const drawer = document.querySelector('#ApexCartDrawer');
    if (!drawer) {
      return;
    }
    const sectionName = drawer.dataset.sectionName;
    const data = await cartApi.renderSection(sectionName);
    const html = new DOMParser().parseFromString(data[sectionName], 'text/html');
    const newDrawer = html.querySelector('#ApexCartDrawer');
    if (newDrawer) {
      drawer.replaceWith(newDrawer);
      initDrawer(newDrawer);
    }
  };

  window.ApexBus.on('cart:request-update', async ({ lineKey, quantity }) => {
    if (!lineKey) {
      return;
    }
    await cartApi.changeLine(lineKey, quantity);
    const updatedCart = await cartApi.fetchCart();
    window.ApexCartState = updatedCart;
    await renderDrawer();
    window.ApexBus.emit('cart:render', { cart: updatedCart });
  });

  window.ApexBus.on('cart:render', () => {
    document.querySelectorAll('upsell-product').forEach((component) => {
      if (typeof component.refresh === 'function') {
        component.refresh();
      }
    });
  });

  document.addEventListener('DOMContentLoaded', () => {
    initDrawer(document.querySelector('#ApexCartDrawer'));

    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-cart-open]');
      if (trigger) {
        openDrawer();
      }
    });
  });
})();
