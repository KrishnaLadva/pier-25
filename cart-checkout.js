export const CART_STORAGE_KEY = 'krazzy_cart_items';

export function getEffectiveItemPrice(item) {
  const base = Number(item?.price);
  if (!Number.isFinite(base) || base <= 0) return null;
  const disc = Number(item?.discountPrice);
  if (Number.isFinite(disc) && disc > 0 && disc < base) {
    return Math.round(disc * 100) / 100;
  }
  return Math.round(base * 100) / 100;
}

export function buildCartKey(itemId, customisations = null) {
  if (!customisations || typeof customisations !== 'object') return itemId;
  const entries = Object.entries(customisations)
    .filter(([, val]) => String(val || '').trim())
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return itemId;
  return `${itemId}::${entries.map(([k, v]) => `${k}=${v}`).join('|')}`;
}

export function formatINR(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '₹0';
  return Number.isInteger(num)
    ? `₹${num.toLocaleString('en-IN')}`
    : `₹${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function addItemToCart(cartItems, item, qty = 1, customisations = null) {
  const unitPrice = getEffectiveItemPrice(item);
  if (unitPrice === null) return cartItems;
  const safeQty = Math.max(1, Math.min(20, Math.floor(Number(qty) || 1)));
  const cartKey = buildCartKey(item.id, customisations);
  const existing = cartItems.find((entry) => (entry.cartKey || entry.id) === cartKey);
  if (existing) {
    return cartItems.map((entry) =>
      (entry.cartKey || entry.id) === cartKey
        ? { ...entry, quantity: Math.min(50, entry.quantity + safeQty) }
        : entry
    );
  }
  return [
    ...cartItems,
    {
      id: item.id,
      cartKey,
      name: item.name,
      price: unitPrice,
      originalPrice: Number(item.price),
      imageUrl: item.imageUrl,
      ...(customisations && Object.keys(customisations).length > 0 ? { customisations } : {}),
      quantity: safeQty,
    },
  ];
}

export function updateCartItemQty(cartItems, keyOrId, nextQty) {
  const qty = Math.floor(Number(nextQty));
  if (!Number.isFinite(qty) || qty <= 0) {
    return cartItems.filter((entry) => entry.cartKey !== keyOrId && entry.id !== keyOrId);
  }
  return cartItems.map((entry) =>
    entry.cartKey === keyOrId || entry.id === keyOrId
      ? { ...entry, quantity: Math.min(50, qty) }
      : entry
  );
}

export function removeCartItem(cartItems, keyOrId) {
  return cartItems.filter((entry) => entry.cartKey !== keyOrId && entry.id !== keyOrId);
}

export function getCartTotalCount(cartItems) {
  return cartItems.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
}

export function computeLocalCartPreview(cartItems, { orderType = 'delivery', settings = {} } = {}) {
  const subtotal = Math.round(
    cartItems.reduce((sum, entry) => sum + Number(entry.price) * Number(entry.quantity), 0) * 100
  ) / 100;
  const taxRate = Number(settings.taxRate ?? 0.05);
  const tax = Math.round(subtotal * taxRate * 100) / 100;
  const threshold = Number(settings.freeDeliveryThreshold ?? 499);
  const fee = Number(settings.deliveryFee ?? 40);
  const deliveryFee = orderType === 'delivery' && subtotal > 0 && subtotal < threshold ? fee : 0;
  const total = Math.round((subtotal + tax + deliveryFee) * 100) / 100;
  return { subtotal, tax, deliveryFee, total };
}

export function parseStoredCart(rawJson) {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry) =>
          entry &&
          typeof entry.id === 'string' &&
          typeof entry.name === 'string' &&
          Number.isFinite(Number(entry.price)) &&
          Number(entry.price) > 0 &&
          Number.isInteger(entry.quantity) &&
          entry.quantity > 0
      )
      .map((entry) => ({
        ...entry,
        cartKey: entry.cartKey || buildCartKey(entry.id, entry.customisations || null),
      }));
  } catch {
    return [];
  }
}

const TRACKING_STEPS = ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed'];

export function createCartController({
  apiFetch,
  getUser,
  onUserUpdated,
  onOrderCompleted,
  onCartChanged,
  getSettings,
  getMenuItems,
}) {
  let cartItems = [];
  let activeOrder = null;
  let pollTimer = null;

  try {
    cartItems = parseStoredCart(window.localStorage.getItem(CART_STORAGE_KEY));
  } catch {
    cartItems = [];
  }

  const drawer = document.querySelector('#cart-drawer');
  const backdrop = document.querySelector('#drawer-backdrop');
  const closeBtn = document.querySelector('#close-cart-btn');
  const cartListEl = document.querySelector('#cart-items-list');
  const cartEmptyEl = document.querySelector('#cart-empty-state');
  const checkoutForm = document.querySelector('#checkout-form');
  const summaryEl = document.querySelector('#checkout-summary');
  const statusEl = document.querySelector('#checkout-status');
  const orderTypeSelect = document.querySelector('#checkout-order-type');
  const addressGroup = document.querySelector('#checkout-address-group');
  const addressInput = document.querySelector('#checkout-address');
  const nameInput = document.querySelector('#checkout-name');
  const phoneInput = document.querySelector('#checkout-phone');
  const notesInput = document.querySelector('#checkout-notes');
  const promoInput = document.querySelector('#checkout-promo');
  const applyPromoBtn = document.querySelector('#apply-promo-btn');
  const redeemPointsCheckbox = document.querySelector('#checkout-redeem-points');
  const redeemPointsLabel = document.querySelector('#checkout-redeem-label');
  const paymentMethodSelect = document.querySelector('#checkout-payment-method');
  const cardFieldsEl = document.querySelector('#payment-card-fields');
  const upiFieldsEl = document.querySelector('#payment-upi-fields');
  const trackingPanel = document.querySelector('#order-tracking-panel');
  const trackingLookupForm = document.querySelector('#order-lookup-form');
  const trackingLookupInput = document.querySelector('#order-lookup-input');

  let quoteState = null;

  function persistCart() {
    try {
      window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cartItems));
    } catch {
      // Ignore storage failures
    }
    onCartChanged?.(getCartTotalCount(cartItems), cartItems);
  }

  function openDrawer() {
    if (!drawer) return;
    drawer.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    if (backdrop) backdrop.hidden = false;
    prefillUserFields();
    refreshQuoteAndRender();
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.hidden = true;
    drawer.setAttribute('aria-hidden', 'true');
    if (backdrop && document.querySelector('#ai-drawer')?.hidden !== false) {
      backdrop.hidden = true;
    }
  }

  function prefillUserFields() {
    const user = getUser();
    if (user) {
      if (nameInput && !nameInput.value) nameInput.value = user.displayName || '';
      if (phoneInput && !phoneInput.value) phoneInput.value = user.phone || '';
      if (addressInput && !addressInput.value) addressInput.value = user.address || '';
    }
    if (redeemPointsLabel) {
      const pts = user?.loyaltyPoints || 0;
      redeemPointsLabel.textContent = user
        ? `Redeem ${pts} Loyalty Points (worth up to ${formatINR(pts / 10)} off)`
        : 'Sign in to earn & redeem Loyalty Points';
    }
    if (redeemPointsCheckbox) {
      redeemPointsCheckbox.disabled = !user || (user.loyaltyPoints || 0) < 50;
      if (redeemPointsCheckbox.disabled) redeemPointsCheckbox.checked = false;
    }
  }

  async function refreshQuoteAndRender() {
    renderCartItems();
    if (cartItems.length === 0) {
      quoteState = null;
      renderSummary();
      return;
    }
    try {
      const res = await apiFetch('/api/orders/quote', {
        method: 'POST',
        body: JSON.stringify({
          items: cartItems.map((c) => ({
            id: c.id,
            quantity: c.quantity,
            ...(c.customisations ? { customisations: c.customisations } : {}),
          })),
          orderType: orderTypeSelect?.value || 'delivery',
          promoCode: promoInput?.value || '',
          redeemPoints: redeemPointsCheckbox?.checked ? (getUser()?.loyaltyPoints || 0) : 0,
        }),
      });
      quoteState = res.totals;
    } catch {
      quoteState = computeLocalCartPreview(cartItems, {
        orderType: orderTypeSelect?.value || 'delivery',
        settings: getSettings(),
      });
    }
    renderSummary();
  }

  function renderCartItems() {
    if (!cartListEl || !cartEmptyEl || !checkoutForm) return;
    cartListEl.innerHTML = '';

    if (cartItems.length === 0) {
      cartEmptyEl.hidden = false;
      checkoutForm.hidden = true;
      return;
    }

    cartEmptyEl.hidden = true;
    checkoutForm.hidden = false;

    const menuMap = new Map((getMenuItems?.() || []).map((m) => [m.id, m]));

    for (const item of cartItems) {
      const latest = menuMap.get(item.id);
      const effectivePrice = latest ? (getEffectiveItemPrice(latest) ?? item.price) : item.price;
      const key = item.cartKey || item.id;

      const li = document.createElement('li');
      li.className = 'cart-row';

      const img = document.createElement('img');
      img.src = latest?.imageUrl || item.imageUrl;
      img.alt = item.name;
      img.className = 'cart-row-img';

      const info = document.createElement('div');
      info.className = 'cart-row-info';
      const title = document.createElement('strong');
      title.textContent = item.name;
      const meta = document.createElement('span');
      meta.className = 'tabular-nums';
      meta.textContent = `${formatINR(effectivePrice)} each`;
      info.append(title, meta);

      if (item.customisations && Object.keys(item.customisations).length > 0) {
        const cust = document.createElement('small');
        cust.className = 'cart-customisation-note';
        cust.textContent = Object.entries(item.customisations)
          .map(([k, v]) => `${k}: ${v}`)
          .join(' · ');
        info.appendChild(cust);
      }

      const controls = document.createElement('div');
      controls.className = 'cart-qty-controls';

      const decBtn = document.createElement('button');
      decBtn.type = 'button';
      decBtn.className = 'qty-btn';
      decBtn.setAttribute('aria-label', `Decrease quantity of ${item.name}`);
      decBtn.textContent = '−';
      decBtn.addEventListener('click', () => {
        cartItems = updateCartItemQty(cartItems, key, item.quantity - 1);
        persistCart();
        refreshQuoteAndRender();
      });

      const qtySpan = document.createElement('span');
      qtySpan.className = 'qty-val tabular-nums';
      qtySpan.textContent = String(item.quantity);

      const incBtn = document.createElement('button');
      incBtn.type = 'button';
      incBtn.className = 'qty-btn';
      incBtn.setAttribute('aria-label', `Increase quantity of ${item.name}`);
      incBtn.textContent = '+';
      incBtn.addEventListener('click', () => {
        cartItems = updateCartItemQty(cartItems, key, item.quantity + 1);
        persistCart();
        refreshQuoteAndRender();
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'cart-remove-btn';
      removeBtn.setAttribute('aria-label', `Remove ${item.name} from cart`);
      removeBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
      removeBtn.addEventListener('click', () => {
        cartItems = removeCartItem(cartItems, key);
        persistCart();
        refreshQuoteAndRender();
      });

      controls.append(decBtn, qtySpan, incBtn, removeBtn);
      li.append(img, info, controls);
      cartListEl.appendChild(li);
    }
  }

  function renderSummary() {
    if (!summaryEl) return;
    if (!quoteState) {
      summaryEl.innerHTML = '';
      return;
    }
    const taxRatePct = Math.round(Number(getSettings?.()?.taxRate ?? 0.05) * 100);
    const rows = [
      ['Subtotal', formatINR(quoteState.subtotal)],
      ...(quoteState.promoDiscount > 0 ? [[`Promo (${quoteState.promoCode})`, `−${formatINR(quoteState.promoDiscount)}`]] : []),
      ...(quoteState.loyaltyDiscount > 0 ? [[`Loyalty Points (${quoteState.pointsRedeemed} pts)`, `−${formatINR(quoteState.loyaltyDiscount)}`]] : []),
      [`GST (${taxRatePct}%)`, formatINR(quoteState.tax)],
      ['Delivery Fee', quoteState.deliveryFee === 0 ? 'Free' : formatINR(quoteState.deliveryFee)],
    ];

    summaryEl.innerHTML = rows
      .map(
        ([label, val]) =>
          `<div class="summary-line"><span>${label}</span><span class="tabular-nums">${val}</span></div>`
      )
      .join('') +
      `<div class="summary-line summary-total"><span>Total</span><span class="tabular-nums">${formatINR(quoteState.total)}</span></div>`;
  }

  function renderTrackingOrder(order) {
    if (!trackingPanel) return;
    if (!order) {
      trackingPanel.hidden = true;
      trackingPanel.innerHTML = '';
      return;
    }

    trackingPanel.hidden = false;
    const activeIdx = TRACKING_STEPS.indexOf(order.status);
    const isCancelled = order.status === 'cancelled';

    const stepsHtml = isCancelled
      ? `<p class="order-cancelled-banner">Order ${order.id} has been cancelled (${order.paymentStatus}).</p>`
      : `<ol class="tracking-steps">
          ${TRACKING_STEPS.map((step, idx) => {
            const done = idx <= activeIdx;
            const label = step.replace(/_/g, ' ');
            return `<li class="${done ? 'step-done' : ''}"><span>${label}</span></li>`;
          }).join('')}
        </ol>`;

    trackingPanel.innerHTML = `
      <div class="tracking-header">
        <div>
          <strong>Live Order ${order.id}</strong>
          <div class="tracking-meta">${order.orderType.replace(/_/g, ' ')} · ${order.itemCount} items · ${formatINR(order.total)} · Ref ${order.paymentReference || 'VERIFIED'}</div>
        </div>
        <button type="button" class="btn-outline-sm" id="refresh-tracking-btn">Refresh</button>
      </div>
      ${stepsHtml}
    `;

    const refreshBtn = trackingPanel.querySelector('#refresh-tracking-btn');
    refreshBtn?.addEventListener('click', () => loadOrderById(order.id));
  }

  async function loadOrderById(orderId) {
    if (!orderId) return;
    try {
      const res = await apiFetch(`/api/orders/${encodeURIComponent(orderId)}`);
      activeOrder = res.order;
      renderTrackingOrder(activeOrder);
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err.message;
        statusEl.className = 'form-status error';
      }
    }
  }

  orderTypeSelect?.addEventListener('change', () => {
    const isDelivery = orderTypeSelect.value === 'delivery';
    if (addressGroup) addressGroup.hidden = !isDelivery;
    refreshQuoteAndRender();
  });

  paymentMethodSelect?.addEventListener('change', () => {
    const method = paymentMethodSelect.value;
    if (cardFieldsEl) cardFieldsEl.hidden = method !== 'card';
    if (upiFieldsEl) upiFieldsEl.hidden = method !== 'upi';
  });

  applyPromoBtn?.addEventListener('click', () => {
    refreshQuoteAndRender();
  });

  redeemPointsCheckbox?.addEventListener('change', () => {
    refreshQuoteAndRender();
  });

  closeBtn?.addEventListener('click', closeDrawer);

  checkoutForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (statusEl) {
      statusEl.textContent = 'Verifying payment & submitting order...';
      statusEl.className = 'form-status info';
    }

    const method = paymentMethodSelect?.value || 'card';
    const paymentPayload = {
      method,
      cardNumber: document.querySelector('#checkout-card-number')?.value || '',
      expiry: document.querySelector('#checkout-card-expiry')?.value || '',
      cvv: document.querySelector('#checkout-card-cvv')?.value || '',
      upiId: document.querySelector('#checkout-upi-id')?.value || '',
    };

    try {
      const result = await apiFetch('/api/orders/checkout', {
        method: 'POST',
        body: JSON.stringify({
          items: cartItems.map((c) => ({
            id: c.id,
            quantity: c.quantity,
            ...(c.customisations ? { customisations: c.customisations } : {}),
          })),
          orderType: orderTypeSelect?.value || 'delivery',
          customerName: nameInput?.value || '',
          customerPhone: phoneInput?.value || '',
          deliveryAddress: addressInput?.value || '',
          notes: notesInput?.value || '',
          promoCode: promoInput?.value || '',
          redeemPoints: redeemPointsCheckbox?.checked ? (getUser()?.loyaltyPoints || 0) : 0,
          payment: paymentPayload,
        }),
      });

      cartItems = [];
      persistCart();
      activeOrder = result.order;
      if (result.user) onUserUpdated?.(result.user);
      onOrderCompleted?.(result.order);

      if (statusEl) {
        statusEl.textContent = `Order ${result.order.id} confirmed! Payment ref: ${result.order.paymentReference}.`;
        statusEl.className = 'form-status success';
      }
      renderCartItems();
      renderSummary();
      renderTrackingOrder(activeOrder);
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = window.setInterval(() => {
        if (activeOrder && !['completed', 'cancelled'].includes(activeOrder.status)) {
          loadOrderById(activeOrder.id);
        }
      }, 15000);
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err.message;
        statusEl.className = 'form-status error';
      }
    }
  });

  trackingLookupForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const id = trackingLookupInput?.value.trim();
    if (id) loadOrderById(id);
  });

  persistCart();

  return {
    addDish(dish, qty = 1, customisations = null) {
      if (getEffectiveItemPrice(dish) === null) {
        if (statusEl) {
          statusEl.textContent = `Price for "${dish.name}" is set by the owner before online ordering.`;
          statusEl.className = 'form-status info';
        }
        return false;
      }
      cartItems = addItemToCart(cartItems, dish, qty, customisations);
      persistCart();
      refreshQuoteAndRender();
      return true;
    },
    openDrawer,
    closeDrawer,
    trackOrder(order) {
      activeOrder = order;
      openDrawer();
      renderTrackingOrder(order);
    },
    getCartCount() {
      return getCartTotalCount(cartItems);
    },
  };
}
