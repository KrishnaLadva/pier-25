function formatRupees(val, { decimals = false } = {}) {
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) return '₹0';
  if (decimals) {
    return `₹${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return Number.isInteger(num)
    ? `₹${num.toLocaleString('en-IN')}`
    : `₹${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatCustomisationsForInput(options) {
  if (!Array.isArray(options) || options.length === 0) return '';
  return options
    .map((g) => `${g.name}: ${(g.choices || []).join(', ')}`)
    .join(' | ');
}

const ALL_CATEGORIES = [
  'Coffee',
  'Croissants',
  'Bakery & Desserts',
  'Chef Specials',
  'Burgers',
  'Wraps & Snacks',
  'Combos',
  'Healthy Bowls',
  'Café & Bakery',
  'Desserts',
  'Beverages',
];

const ALL_SUBCATEGORIES = [
  'Espresso', 'Double Espresso', 'Americano', 'Cappuccino', 'Café Latte', 'Flat White',
  'Mocha', 'Macchiato', 'Caramel Macchiato', 'Vanilla Latte', 'Hazelnut Latte', 'Spanish Latte',
  'Iced Americano', 'Iced Latte', 'Iced Mocha', 'Cold Coffee', 'Cold Brew', 'Vietnamese Coffee',
  'Classic Butter Croissant', 'Chocolate Croissant', 'Almond Croissant', 'Strawberry Croissant',
  'Blueberry Croissant', 'Pistachio Croissant', 'Nutella Croissant', 'Cheese Croissant',
  'Garlic Croissant', 'Cream Cheese Croissant', 'Chicken Croissant', 'Mushroom Croissant',
  'Chocolate Muffin', 'Blueberry Muffin', 'Cinnamon Roll', 'Brownies',
  'Cheesecake', 'Tiramisu', 'Cookies', 'Danish Pastry',
];

const SHOWCASE_OPTIONS = [
  'Hot Coffee',
  'Cold Coffee',
  'Speciality Coffee',
  'Classic Croissants',
  'Chocolate & Nut Croissants',
  'Fruit Croissants',
  'Savory Croissants',
  'Bakery & Desserts',
  'Signature Menu',
];

export function createOwnerDashboardController({
  apiFetch,
  getMenuItems,
  onMenuMutated,
  onMenuSyncToFirestore,
  onMenuDeleteFromFirestore,
  onReservationsMutated,
}) {
  const modal = document.querySelector('#owner-dashboard-modal');
  const closeBtn = document.querySelector('#close-owner-modal');
  const tabBtns = document.querySelectorAll('[data-owner-tab]');
  const bodyEl = document.querySelector('#owner-tab-content');

  let activeTab = 'overview';
  let snapshot = null;
  let editingDishId = null;
  let menuFilterText = '';
  let menuFilterCategory = 'all';

  function openModal(tab = 'overview') {
    if (!modal) return;
    modal.hidden = false;
    activeTab = tab;
    loadAndRender();
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
  }

  async function loadAndRender() {
    if (!bodyEl) return;
    tabBtns.forEach((btn) => {
      const isActive = btn.getAttribute('data-owner-tab') === activeTab;
      btn.classList.toggle('active', isActive);
    });
    bodyEl.innerHTML = '<p class="owner-loading">Loading restaurant operations...</p>';
    try {
      snapshot = await apiFetch('/api/owner/overview');
      renderActiveTab();
    } catch (err) {
      bodyEl.innerHTML = `<p class="form-status error">${escapeAttr(err.message)}</p>`;
    }
  }

  function renderActiveTab() {
    if (!bodyEl || !snapshot) return;
    if (activeTab === 'overview') return renderOverview();
    if (activeTab === 'menu') return renderMenuManager();
    if (activeTab === 'orders') return renderOrdersManager();
    if (activeTab === 'reservations') return renderReservationsManager();
    if (activeTab === 'inventory') return renderInventoryManager();
    if (activeTab === 'crm') return renderCrmAndReviews();
    if (activeTab === 'ai-studio') return renderAiStudioAndSettings();
  }

  function renderOverview() {
    const a = snapshot.analytics;
    const maxCatRev = Math.max(1, ...(a.categoryBreakdown || []).map((c) => c.revenue));

    bodyEl.innerHTML = `
      <div class="owner-kpi-grid">
        <div class="owner-kpi"><span>Total Revenue</span><strong class="tabular-nums">${formatRupees(a.totalRevenue, { decimals: true })}</strong></div>
        <div class="owner-kpi"><span>Orders (${a.activeOrders} active)</span><strong class="tabular-nums">${a.totalOrders}</strong></div>
        <div class="owner-kpi"><span>Avg Order Value</span><strong class="tabular-nums">${formatRupees(a.avgOrderValue, { decimals: true })}</strong></div>
        <div class="owner-kpi"><span>Reservations</span><strong class="tabular-nums">${a.upcomingReservations} upcoming</strong></div>
        <div class="owner-kpi"><span>Guest Rating</span><strong class="tabular-nums">${a.averageRating} / 5 (${a.reviewCount})</strong></div>
        <div class="owner-kpi ${a.lowStockCount > 0 ? 'kpi-warn' : ''}"><span>Low Stock Alerts</span><strong class="tabular-nums">${a.lowStockCount}</strong></div>
      </div>
      <div class="owner-two-col">
        <div class="owner-card">
          <h4>Revenue by Category</h4>
          ${
            a.categoryBreakdown.length === 0
              ? '<p class="muted-empty">No completed or active orders recorded yet. Orders placed via checkout appear here automatically.</p>'
              : a.categoryBreakdown
                  .map(
                    (c) => `
                <div class="bar-row">
                  <span>${escapeAttr(c.category)}</span>
                  <div class="bar-track"><div class="bar-fill" style="width:${Math.round((c.revenue / maxCatRev) * 100)}%"></div></div>
                  <strong class="tabular-nums">${formatRupees(c.revenue, { decimals: true })}</strong>
                </div>`
                  )
                  .join('')
          }
        </div>
        <div class="owner-card">
          <h4>Top Dishes &amp; Stock Watch</h4>
          ${
            a.topDishes.length === 0
              ? '<p class="muted-empty">Top-performing dishes will rank here once guests check out.</p>'
              : `<ul class="compact-list">${a.topDishes.map((d) => `<li><span>${escapeAttr(d.name)} (${d.qty} sold)</span><strong class="tabular-nums">${formatRupees(d.revenue, { decimals: true })}</strong></li>`).join('')}</ul>`
          }
          ${
            a.lowStockItems.length
              ? `<div class="stock-alert-box"><strong>Reorder Soon:</strong> ${a.lowStockItems.map((i) => `${escapeAttr(i.name)} (${i.stockQty} left)`).join(' · ')}</div>`
              : ''
          }
        </div>
      </div>
    `;
  }

  function renderMenuManager() {
    const items = getMenuItems() || [];
    const editingItem = editingDishId ? items.find((m) => m.id === editingDishId) : null;
    const unpricedCount = items.filter((m) => m.price === null || m.price === undefined || Number(m.price) <= 0).length;

    const filteredItems = items.filter((m) => {
      const hasPrice = m.price !== null && m.price !== undefined && Number(m.price) > 0;
      if (menuFilterCategory === 'unpriced' && hasPrice) return false;
      if (menuFilterCategory === 'other' && ['Coffee', 'Croissants', 'Bakery & Desserts'].includes(m.category)) return false;
      if (!['all', 'unpriced', 'other'].includes(menuFilterCategory) && m.category !== menuFilterCategory) return false;
      if (menuFilterText.trim()) {
        const q = menuFilterText.trim().toLowerCase();
        const hay = `${m.name} ${m.category} ${m.subcategory || ''} ${(m.ingredients || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    bodyEl.innerHTML = `
      <div class="owner-two-col owner-menu-layout">
        <form id="owner-menu-form" class="owner-card owner-form">
          <div class="owner-card-head">
            <h4>${editingItem ? `Edit Food Item: ${escapeAttr(editingItem.name)}` : 'Add Food Item'}</h4>
            ${editingItem ? '<button type="button" class="btn-outline-sm" id="owner-cancel-edit">Cancel Edit</button>' : ''}
          </div>

          <label>Food Item Name
            <input type="text" id="om-name" required value="${escapeAttr(editingItem?.name || '')}" placeholder="e.g. Caramel Macchiato">
          </label>

          <div class="owner-form-row">
            <label>Category
              <input type="text" id="om-category" list="om-category-list" required value="${escapeAttr(editingItem?.category || 'Coffee')}">
              <datalist id="om-category-list">
                ${ALL_CATEGORIES.map((c) => `<option value="${escapeAttr(c)}"></option>`).join('')}
              </datalist>
            </label>
            <label>Subcategory
              <input type="text" id="om-subcategory" list="om-subcategory-list" value="${escapeAttr(editingItem?.subcategory || '')}" placeholder="e.g. Espresso, Almond Croissant">
              <datalist id="om-subcategory-list">
                ${ALL_SUBCATEGORIES.map((s) => `<option value="${escapeAttr(s)}"></option>`).join('')}
              </datalist>
            </label>
          </div>

          <div class="owner-form-row">
            <label>Price (₹ INR — optional until set)
              <input type="number" step="1" min="1" max="100000" id="om-price" value="${editingItem?.price ?? ''}" placeholder="Leave blank if pending">
            </label>
            <label>Discount Price (₹ INR — optional)
              <input type="number" step="1" min="1" max="100000" id="om-discount" value="${editingItem?.discountPrice ?? ''}" placeholder="Lower offer ₹ price">
            </label>
          </div>

          <div class="owner-form-row">
            <label>Veg / Non-Veg Classification
              <select id="om-dietary-type">
                <option value="veg" ${editingItem?.dietaryType !== 'non-veg' ? 'selected' : ''}>Veg</option>
                <option value="non-veg" ${editingItem?.dietaryType === 'non-veg' ? 'selected' : ''}>Non-Veg</option>
              </select>
            </label>
            <label>Stock &amp; Availability Status
              <select id="om-stock-status">
                <option value="in_stock" ${(editingItem?.stockStatus || 'in_stock') === 'in_stock' ? 'selected' : ''}>In Stock (Available)</option>
                <option value="low_stock" ${editingItem?.stockStatus === 'low_stock' ? 'selected' : ''}>Low Stock</option>
                <option value="out_of_stock" ${editingItem?.stockStatus === 'out_of_stock' ? 'selected' : ''}>Out of Stock (Unavailable)</option>
              </select>
            </label>
          </div>

          <div class="owner-form-row">
            <label>Customer Showcase Section
              <select id="om-section">
                <option value="">Auto by Category</option>
                ${SHOWCASE_OPTIONS.map((sec) => `<option value="${escapeAttr(sec)}" ${editingItem?.showcaseSection === sec ? 'selected' : ''}>${escapeAttr(sec)}</option>`).join('')}
              </select>
            </label>
            <label>Prep Minutes
              <input type="number" min="1" max="240" id="om-prep" value="${editingItem?.prepMinutes || 6}">
            </label>
          </div>

          <label>Ingredients (comma separated)
            <input type="text" id="om-ingredients" value="${escapeAttr((editingItem?.ingredients || []).join(', '))}" placeholder="Arabica Espresso, Steamed Milk, Vanilla">
          </label>

          <label>Customisation Options (Group: Opt1, Opt2 | Group 2: OptA, OptB)
            <input type="text" id="om-customisations" value="${escapeAttr(formatCustomisationsForInput(editingItem?.customisationOptions))}" placeholder="Cup Size: Regular, Large | Milk Choice: Dairy, Oat, Almond">
          </label>

          <div class="owner-ai-inline">
            <button type="button" class="btn-gold-sm" id="om-ai-describe">
              <i class="fa-solid fa-wand-magic-sparkles"></i> Generate Description with Gemini AI
            </button>
            <span id="om-ai-status" class="inline-status"></span>
          </div>

          <label>Description <textarea id="om-description" rows="2" required>${escapeAttr(editingItem?.description || '')}</textarea></label>

          <div class="owner-form-row">
            <label>Dietary Tags (comma separated) <input type="text" id="om-tags" value="${escapeAttr((editingItem?.dietaryTags || []).join(', '))}"></label>
            <label>Calories (kcal) <input type="number" min="0" max="5000" id="om-calories" value="${editingItem?.calories ?? 220}"></label>
          </div>

          <div class="owner-form-row">
            <label>Food Image Path or Upload <input type="text" id="om-image" value="${escapeAttr(editingItem?.imageUrl || '/src/assets/images/hot_espresso_latte_1794843900170.jpg')}"></label>
            <label>Upload Food Photo <input type="file" id="om-image-file" accept="image/png,image/jpeg,image/webp"></label>
          </div>

          <div class="owner-checkbox-row">
            <label><input type="checkbox" id="om-available" ${editingItem?.available !== false ? 'checked' : ''}> Available</label>
            <label><input type="checkbox" id="om-bestseller" ${editingItem?.isBestseller || editingItem?.isPopular ? 'checked' : ''}> Bestseller</label>
            <label><input type="checkbox" id="om-new" ${editingItem ? (editingItem.isNewArrival || editingItem.isNew ? 'checked' : '') : 'checked'}> New Arrival</label>
            <label><input type="checkbox" id="om-recommended" ${editingItem?.isRecommended ? 'checked' : ''}> Recommended</label>
          </div>

          <button type="submit" class="btn-forest">${editingItem ? 'Save Food Item Changes' : 'Add to Food Items'}</button>
          <p id="om-form-status" class="form-status"></p>
        </form>

        <div class="owner-card">
          <div class="owner-card-head">
            <h4>Unified Food Items (${items.length} total · ${unpricedCount} awaiting ₹ price)</h4>
          </div>
          <div class="owner-filter-bar">
            <input type="search" id="om-filter-search" value="${escapeAttr(menuFilterText)}" placeholder="Filter Food Items by name, subcategory...">
            <select id="om-filter-category">
              <option value="all" ${menuFilterCategory === 'all' ? 'selected' : ''}>All Food Items (${items.length})</option>
              <option value="unpriced" ${menuFilterCategory === 'unpriced' ? 'selected' : ''}>Awaiting ₹ Price (${unpricedCount})</option>
              <option value="Coffee" ${menuFilterCategory === 'Coffee' ? 'selected' : ''}>Coffee</option>
              <option value="Croissants" ${menuFilterCategory === 'Croissants' ? 'selected' : ''}>Croissants</option>
              <option value="Bakery & Desserts" ${menuFilterCategory === 'Bakery & Desserts' ? 'selected' : ''}>Bakery &amp; Desserts</option>
              <option value="other" ${menuFilterCategory === 'other' ? 'selected' : ''}>Mains, Burgers &amp; Combos</option>
            </select>
          </div>
          <p id="om-inline-status" class="form-status"></p>
          <div class="owner-table-wrap owner-food-table-scroll">
            <table class="owner-table">
              <thead>
                <tr>
                  <th>Food Item</th>
                  <th>Category / Subcategory</th>
                  <th>Price (₹) &amp; Offer (₹)</th>
                  <th>Stock &amp; Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filteredItems
                  .map((m) => {
                    const isUnpriced = m.price === null || m.price === undefined || Number(m.price) <= 0;
                    const tags = [
                      m.isBestseller || m.isPopular ? 'Bestseller' : '',
                      m.isNewArrival || m.isNew ? 'New' : '',
                      m.isRecommended ? 'Rec' : '',
                    ]
                      .filter(Boolean)
                      .join(' · ');
                    return `
                  <tr class="${isUnpriced ? 'row-pending-price' : ''}">
                    <td>
                      <strong>${escapeAttr(m.name)}</strong>
                      <div class="owner-cell-meta">
                        <span>${m.dietaryType === 'non-veg' ? 'Non-Veg' : 'Veg'}</span>
                        ${tags ? ` · <span>${escapeAttr(tags)}</span>` : ''}
                      </div>
                    </td>
                    <td>
                      <div>${escapeAttr(m.category)}</div>
                      <small class="muted-empty">${escapeAttr(m.subcategory || m.showcaseSection || '—')}</small>
                    </td>
                    <td>
                      <div class="inline-price-editor">
                        <input type="number" min="1" max="100000" step="1" class="inline-rupee-input" data-inline-price="${escapeAttr(m.id)}" value="${m.price ?? ''}" placeholder="₹ Price" aria-label="Regular price in rupees for ${escapeAttr(m.name)}">
                        <input type="number" min="1" max="100000" step="1" class="inline-rupee-input" data-inline-discount="${escapeAttr(m.id)}" value="${m.discountPrice ?? ''}" placeholder="Offer ₹" aria-label="Discount price in rupees for ${escapeAttr(m.name)}">
                        <button type="button" class="btn-gold-sm" data-save-price="${escapeAttr(m.id)}">Save ₹</button>
                      </div>
                    </td>
                    <td>
                      <div class="inline-status-stack">
                        <select data-inline-stock="${escapeAttr(m.id)}" aria-label="Stock status for ${escapeAttr(m.name)}">
                          <option value="in_stock" ${(m.stockStatus || 'in_stock') === 'in_stock' ? 'selected' : ''}>In Stock</option>
                          <option value="low_stock" ${m.stockStatus === 'low_stock' ? 'selected' : ''}>Low Stock</option>
                          <option value="out_of_stock" ${m.stockStatus === 'out_of_stock' ? 'selected' : ''}>Out of Stock</option>
                        </select>
                        <button type="button" class="btn-outline-sm" data-toggle-avail="${escapeAttr(m.id)}">${m.available ? 'Active' : 'Unavailable'}</button>
                      </div>
                    </td>
                    <td class="table-actions">
                      <button type="button" class="btn-outline-sm" data-edit-dish="${escapeAttr(m.id)}">Edit</button>
                      <button type="button" class="btn-danger-sm" data-del-dish="${escapeAttr(m.id)}">Delete</button>
                    </td>
                  </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    bodyEl.querySelector('#om-filter-search')?.addEventListener('input', (e) => {
      menuFilterText = e.target.value;
      renderMenuManager();
      const input = bodyEl.querySelector('#om-filter-search');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });

    bodyEl.querySelector('#om-filter-category')?.addEventListener('change', (e) => {
      menuFilterCategory = e.target.value;
      renderMenuManager();
    });

    bodyEl.querySelector('#owner-cancel-edit')?.addEventListener('click', () => {
      editingDishId = null;
      renderMenuManager();
    });

    bodyEl.querySelector('#om-image-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const status = bodyEl.querySelector('#om-form-status');
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          if (status) status.textContent = 'Uploading image...';
          const res = await apiFetch('/api/owner/upload-image', {
            method: 'POST',
            body: JSON.stringify({ imageBase64: reader.result }),
          });
          bodyEl.querySelector('#om-image').value = res.imageUrl;
          if (status) {
            status.textContent = `Uploaded to ${res.imageUrl}`;
            status.className = 'form-status success';
          }
        } catch (err) {
          if (status) {
            status.textContent = err.message;
            status.className = 'form-status error';
          }
        }
      };
      reader.readAsDataURL(file);
    });

    bodyEl.querySelector('#om-ai-describe')?.addEventListener('click', async () => {
      const name = bodyEl.querySelector('#om-name').value.trim();
      const category = bodyEl.querySelector('#om-category').value.trim();
      const ingredients = bodyEl.querySelector('#om-ingredients').value.split(',').map((s) => s.trim()).filter(Boolean);
      const aiStatus = bodyEl.querySelector('#om-ai-status');
      if (!name) {
        aiStatus.textContent = 'Enter a food item name first.';
        return;
      }
      aiStatus.textContent = 'Generating copy...';
      try {
        const res = await apiFetch('/api/ai/menu-description', {
          method: 'POST',
          body: JSON.stringify({ name, category, ingredients }),
        });
        bodyEl.querySelector('#om-description').value = res.description || '';
        if (res.suggestedTags?.length) bodyEl.querySelector('#om-tags').value = res.suggestedTags.join(', ');
        if (res.suggestedPrepMinutes) bodyEl.querySelector('#om-prep').value = res.suggestedPrepMinutes;
        aiStatus.textContent = 'Generated by Gemini AI';
      } catch (err) {
        aiStatus.textContent = err.message;
      }
    });

    bodyEl.querySelector('#owner-menu-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = bodyEl.querySelector('#om-form-status');
      const rawPrice = bodyEl.querySelector('#om-price').value.trim();
      const rawDiscount = bodyEl.querySelector('#om-discount').value.trim();
      const isBestseller = bodyEl.querySelector('#om-bestseller').checked;
      const isNewArrival = bodyEl.querySelector('#om-new').checked;
      const stockStatus = bodyEl.querySelector('#om-stock-status').value;

      const payload = {
        name: bodyEl.querySelector('#om-name').value,
        category: bodyEl.querySelector('#om-category').value,
        subcategory: bodyEl.querySelector('#om-subcategory').value,
        showcaseSection: bodyEl.querySelector('#om-section').value,
        price: rawPrice === '' ? null : Number(rawPrice),
        discountPrice: rawDiscount === '' ? null : Number(rawDiscount),
        dietaryType: bodyEl.querySelector('#om-dietary-type').value,
        stockStatus,
        available: stockStatus === 'out_of_stock' ? false : bodyEl.querySelector('#om-available').checked,
        ingredients: bodyEl.querySelector('#om-ingredients').value,
        customisationOptions: bodyEl.querySelector('#om-customisations').value,
        description: bodyEl.querySelector('#om-description').value,
        dietaryTags: bodyEl.querySelector('#om-tags').value,
        prepMinutes: Number(bodyEl.querySelector('#om-prep').value),
        calories: Number(bodyEl.querySelector('#om-calories').value),
        imageUrl: bodyEl.querySelector('#om-image').value,
        isBestseller,
        isPopular: isBestseller,
        isNewArrival,
        isNew: isNewArrival,
        isRecommended: bodyEl.querySelector('#om-recommended').checked,
      };
      try {
        let savedRes;
        if (editingDishId) {
          savedRes = await apiFetch(`/api/owner/menu/${encodeURIComponent(editingDishId)}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
          });
        } else {
          savedRes = await apiFetch('/api/owner/menu', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        }
        if (savedRes?.item) {
          onMenuSyncToFirestore?.(savedRes.item).catch(() => {});
        }
        editingDishId = null;
        await onMenuMutated?.();
        await loadAndRender();
      } catch (err) {
        status.textContent = err.message;
        status.className = 'form-status error';
      }
    });

    // Inline ₹ Price + Discount ₹ Save
    bodyEl.querySelectorAll('[data-save-price]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-save-price');
        const inlineStatus = bodyEl.querySelector('#om-inline-status');
        const priceEl = bodyEl.querySelector(`[data-inline-price="${CSS.escape(id)}"]`);
        const discountEl = bodyEl.querySelector(`[data-inline-discount="${CSS.escape(id)}"]`);
        const rawPrice = priceEl?.value.trim() ?? '';
        const rawDiscount = discountEl?.value.trim() ?? '';

        try {
          const res = await apiFetch(`/api/owner/menu/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({
              price: rawPrice === '' ? null : Number(rawPrice),
              discountPrice: rawDiscount === '' ? null : Number(rawDiscount),
            }),
          });
          if (res?.item) onMenuSyncToFirestore?.(res.item).catch(() => {});
          await onMenuMutated?.();
          await loadAndRender();
          const refreshedStatus = bodyEl.querySelector('#om-inline-status');
          if (refreshedStatus && res?.item) {
            refreshedStatus.textContent = `Updated ${res.item.name} price to ${res.item.price ? formatRupees(res.item.price) : 'Pending'}.`;
            refreshedStatus.className = 'form-status success';
          }
        } catch (err) {
          if (inlineStatus) {
            inlineStatus.textContent = err.message;
            inlineStatus.className = 'form-status error';
          }
        }
      });
    });

    // Inline Stock Status Change
    bodyEl.querySelectorAll('[data-inline-stock]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.getAttribute('data-inline-stock');
        try {
          const res = await apiFetch(`/api/owner/menu/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({
              stockStatus: sel.value,
              available: sel.value !== 'out_of_stock',
            }),
          });
          if (res?.item) onMenuSyncToFirestore?.(res.item).catch(() => {});
          await onMenuMutated?.();
          await loadAndRender();
        } catch (err) {
          const inlineStatus = bodyEl.querySelector('#om-inline-status');
          if (inlineStatus) {
            inlineStatus.textContent = err.message;
            inlineStatus.className = 'form-status error';
          }
        }
      });
    });

    // Inline Available / Unavailable Toggle
    bodyEl.querySelectorAll('[data-toggle-avail]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-toggle-avail');
        const current = items.find((m) => m.id === id);
        if (!current) return;
        const nextAvailable = current.available === false;
        const res = await apiFetch(`/api/owner/menu/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            available: nextAvailable,
            stockStatus: nextAvailable ? 'in_stock' : 'out_of_stock',
          }),
        });
        if (res?.item) onMenuSyncToFirestore?.(res.item).catch(() => {});
        await onMenuMutated?.();
        await loadAndRender();
      });
    });

    bodyEl.querySelectorAll('[data-edit-dish]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingDishId = btn.getAttribute('data-edit-dish');
        renderMenuManager();
      });
    });

    bodyEl.querySelectorAll('[data-del-dish]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-del-dish');
        await apiFetch(`/api/owner/menu/${encodeURIComponent(id)}`, { method: 'DELETE' });
        onMenuDeleteFromFirestore?.(id).catch(() => {});
        await onMenuMutated?.();
        await loadAndRender();
      });
    });
  }

  function renderOrdersManager() {
    const orders = snapshot.orders || [];
    const statuses = ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'];
    bodyEl.innerHTML = `
      <div class="owner-card">
        <h4>Customer Orders (${orders.length})</h4>
        ${
          orders.length === 0
            ? '<p class="muted-empty">No customer orders yet.</p>'
            : `<div class="owner-table-wrap"><table class="owner-table">
                <thead><tr><th>Order</th><th>Guest</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th></tr></thead>
                <tbody>
                  ${orders
                    .map(
                      (o) => `
                    <tr>
                      <td><strong>${escapeAttr(o.id)}</strong><br><small>${escapeAttr(o.orderType)}</small></td>
                      <td>${escapeAttr(o.customerName)}<br><small>${escapeAttr(o.deliveryAddress || o.customerPhone || '')}</small></td>
                      <td>${(o.items || []).map((i) => `${i.quantity}× ${escapeAttr(i.name)}${i.customisationSummary ? ` (${escapeAttr(i.customisationSummary)})` : ''}`).join(', ')}</td>
                      <td class="tabular-nums">${formatRupees(o.total, { decimals: true })}</td>
                      <td>${escapeAttr(o.paymentStatus)} <br><small>${escapeAttr(o.paymentReference || '')}</small></td>
                      <td>
                        <select data-order-status="${escapeAttr(o.id)}">
                          ${statuses.map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}
                        </select>
                      </td>
                    </tr>`
                    )
                    .join('')}
                </tbody>
              </table></div>`
        }
      </div>
    `;

    bodyEl.querySelectorAll('[data-order-status]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.getAttribute('data-order-status');
        await apiFetch(`/api/owner/orders/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: sel.value }),
        });
        loadAndRender();
      });
    });
  }

  function renderReservationsManager() {
    const resList = snapshot.reservations || [];
    const statuses = ['confirmed', 'seated', 'completed', 'cancelled'];
    bodyEl.innerHTML = `
      <div class="owner-card">
        <h4>Table Reservations (${resList.length})</h4>
        ${
          resList.length === 0
            ? '<p class="muted-empty">No table reservations recorded yet.</p>'
            : `<div class="owner-table-wrap"><table class="owner-table">
                <thead><tr><th>ID</th><th>Guest</th><th>Date &amp; Time</th><th>Party</th><th>Status</th></tr></thead>
                <tbody>
                  ${resList
                    .map(
                      (r) => `
                    <tr>
                      <td><strong>${escapeAttr(r.id)}</strong></td>
                      <td>${escapeAttr(r.name)}</td>
                      <td class="tabular-nums">${escapeAttr(r.date)} · ${escapeAttr(r.time)}</td>
                      <td class="tabular-nums">${r.partySize} guests</td>
                      <td>
                        <select data-res-status="${escapeAttr(r.id)}">
                          ${statuses.map((s) => `<option value="${s}" ${r.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                      </td>
                    </tr>`
                    )
                    .join('')}
                </tbody>
              </table></div>`
        }
      </div>
    `;

    bodyEl.querySelectorAll('[data-res-status]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.getAttribute('data-res-status');
        await apiFetch(`/api/owner/reservations/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: sel.value }),
        });
        await onReservationsMutated?.();
        loadAndRender();
      });
    });
  }

  function renderInventoryManager() {
    const inv = snapshot.inventory || [];
    bodyEl.innerHTML = `
      <div class="owner-two-col">
        <div class="owner-card">
          <h4>Kitchen Inventory (${inv.length} SKUs)</h4>
          <div class="owner-table-wrap">
            <table class="owner-table">
              <thead><tr><th>Ingredient</th><th>SKU</th><th>In Stock</th><th>Reorder</th><th>Adjust</th></tr></thead>
              <tbody>
                ${inv
                  .map(
                    (i) => `
                  <tr class="${i.stockQty <= i.reorderLevel ? 'row-warn' : ''}">
                    <td><strong>${escapeAttr(i.name)}</strong></td>
                    <td class="tabular-nums">${escapeAttr(i.sku)}</td>
                    <td class="tabular-nums">${i.stockQty} ${escapeAttr(i.unit)}</td>
                    <td class="tabular-nums">${i.reorderLevel} ${escapeAttr(i.unit)}</td>
                    <td class="table-actions">
                      <button type="button" class="btn-outline-sm" data-inv-delta="${escapeAttr(i.id)}:-5">−5</button>
                      <button type="button" class="btn-gold-sm" data-inv-delta="${escapeAttr(i.id)}:10">+10</button>
                    </td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
        <form id="owner-inv-form" class="owner-card owner-form">
          <h4>Add Inventory Item</h4>
          <label>Ingredient Name <input type="text" id="inv-name" required></label>
          <div class="owner-form-row">
            <label>Unit <input type="text" id="inv-unit" value="kg" required></label>
            <label>Initial Qty <input type="number" id="inv-qty" value="20" min="0" required></label>
          </div>
          <div class="owner-form-row">
            <label>Reorder Level <input type="number" id="inv-reorder" value="5" min="0" required></label>
            <label>Cost/Unit (₹) <input type="number" step="1" id="inv-cost" value="250" min="0" required></label>
          </div>
          <button type="submit" class="btn-forest">Add Inventory Stock</button>
        </form>
      </div>
    `;

    bodyEl.querySelectorAll('[data-inv-delta]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const [id, deltaStr] = btn.getAttribute('data-inv-delta').split(':');
        const current = inv.find((item) => item.id === id);
        if (!current) return;
        await apiFetch(`/api/owner/inventory/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({ stockQty: Math.max(0, Number(current.stockQty) + Number(deltaStr)) }),
        });
        loadAndRender();
      });
    });

    bodyEl.querySelector('#owner-inv-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await apiFetch('/api/owner/inventory', {
        method: 'POST',
        body: JSON.stringify({
          name: bodyEl.querySelector('#inv-name').value,
          unit: bodyEl.querySelector('#inv-unit').value,
          stockQty: Number(bodyEl.querySelector('#inv-qty').value),
          reorderLevel: Number(bodyEl.querySelector('#inv-reorder').value),
          costPerUnit: Number(bodyEl.querySelector('#inv-cost').value),
        }),
      });
      loadAndRender();
    });
  }

  function renderCrmAndReviews() {
    const customers = snapshot.customers || [];
    const reviews = snapshot.reviews || [];
    bodyEl.innerHTML = `
      <div class="owner-two-col">
        <div class="owner-card">
          <h4>Customer CRM (${customers.length})</h4>
          ${
            customers.length === 0
              ? '<p class="muted-empty">Registered customer profiles appear here.</p>'
              : `<div class="owner-table-wrap"><table class="owner-table">
                  <thead><tr><th>Guest</th><th>Orders</th><th>Spent</th><th>Loyalty</th></tr></thead>
                  <tbody>
                    ${customers
                      .map(
                        (c) => `<tr><td><strong>${escapeAttr(c.displayName)}</strong><br><small>${escapeAttr(c.email)}</small></td><td class="tabular-nums">${c.totalOrders}</td><td class="tabular-nums">${formatRupees(c.totalSpent, { decimals: true })}</td><td class="tabular-nums">${c.loyaltyPoints} pts</td></tr>`
                      )
                      .join('')}
                  </tbody>
                </table></div>`
          }
        </div>
        <div class="owner-card">
          <div class="owner-card-head">
            <h4>Reviews &amp; Sentiment (${reviews.length})</h4>
            <button type="button" class="btn-gold-sm" id="owner-run-sentiment">Run AI Sentiment</button>
          </div>
          <div id="owner-sentiment-box" hidden></div>
          <ul class="compact-list">
            ${reviews
              .map(
                (r) => `
              <li>
                <div><strong>${escapeAttr(r.authorName)}</strong> (${r.rating}★)<br><small>${escapeAttr(r.comment)}</small></div>
                <button type="button" class="btn-danger-sm" data-del-review="${escapeAttr(r.id)}">Remove</button>
              </li>`
              )
              .join('')}
          </ul>
        </div>
      </div>
    `;

    bodyEl.querySelector('#owner-run-sentiment')?.addEventListener('click', async () => {
      const box = bodyEl.querySelector('#owner-sentiment-box');
      box.hidden = false;
      box.innerHTML = '<p class="ai-loading-text">Analyzing guest sentiment with Gemini...</p>';
      try {
        const res = await apiFetch('/api/ai/sentiment', { method: 'POST', body: '{}' });
        box.innerHTML = `
          <div class="ai-insight-box">
            <strong>Sentiment: ${escapeAttr(res.overallSentiment)}</strong>
            <div class="tabular-nums">Positive ${res.positivePercent}% · Neutral ${res.neutralPercent}% · Negative ${res.negativePercent}%</div>
            <p><strong>Strengths:</strong> ${(res.topStrengths || []).map(escapeAttr).join(' · ')}</p>
            <p><strong>Next Actions:</strong> ${(res.recommendedActions || []).map(escapeAttr).join(' · ')}</p>
          </div>
        `;
      } catch (err) {
        box.innerHTML = `<p class="form-status error">${escapeAttr(err.message)}</p>`;
      }
    });

    bodyEl.querySelectorAll('[data-del-review]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-del-review');
        await apiFetch(`/api/owner/reviews/${encodeURIComponent(id)}`, { method: 'DELETE' });
        loadAndRender();
      });
    });
  }

  function renderAiStudioAndSettings() {
    const s = snapshot.settings;
    const staff = snapshot.staff || [];
    bodyEl.innerHTML = `
      <div class="owner-two-col">
        <div class="owner-card owner-form">
          <h4>AI Marketing Studio</h4>
          <form id="owner-promo-form" class="owner-form">
            <label>Campaign Goal <input type="text" id="promo-goal" value="Morning artisanal coffee & croissant pairing" required></label>
            <label>Featured Dish <input type="text" id="promo-dish" value="Classic Butter Croissant & Caramel Macchiato"></label>
            <button type="submit" class="btn-gold-sm">Generate Campaign Copy</button>
          </form>
          <div id="owner-promo-result"></div>

          <hr class="owner-divider">
          <h4>AI Business Assistant &amp; Demand Forecast</h4>
          <form id="owner-biz-form" class="owner-form">
            <label>Ask Strategist <input type="text" id="biz-question" placeholder="How should we optimize café & sizzler margins in ₹?" required></label>
            <div class="owner-checkbox-row">
              <button type="submit" class="btn-forest">Ask AI Strategist</button>
              <button type="button" class="btn-outline-sm" id="owner-forecast-btn">Run Demand Forecast</button>
            </div>
          </form>
          <div id="owner-biz-result"></div>
        </div>

        <div class="owner-card owner-form">
          <h4>Staff &amp; Restaurant Settings</h4>
          <ul class="compact-list">
            ${staff
              .map(
                (m) => `<li><div><strong>${escapeAttr(m.name)}</strong> — ${escapeAttr(m.role)}<br><small>${escapeAttr(m.shift)}</small></div><span>${escapeAttr(m.status)}</span></li>`
              )
              .join('')}
          </ul>
          <form id="owner-staff-form" class="owner-form-inline">
            <input type="text" id="stf-name" placeholder="Staff name" required>
            <input type="text" id="stf-role" placeholder="Role" required>
            <button type="submit" class="btn-outline-sm">Add Staff</button>
          </form>
          <hr class="owner-divider">
          <form id="owner-settings-form" class="owner-form">
            <div class="owner-form-row">
              <label>GST / Tax Rate <input type="number" step="0.01" id="set-tax" value="${s.taxRate}"></label>
              <label>Delivery Fee (₹) <input type="number" step="1" id="set-fee" value="${s.deliveryFee}"></label>
            </div>
            <div class="owner-checkbox-row">
              <label><input type="checkbox" id="set-orders" ${s.acceptingOrders ? 'checked' : ''}> Accept Online Orders</label>
              <label><input type="checkbox" id="set-res" ${s.acceptingReservations ? 'checked' : ''}> Accept Reservations</label>
            </div>
            <button type="submit" class="btn-forest">Save Settings</button>
            <span id="set-status" class="inline-status"></span>
          </form>
        </div>
      </div>
    `;

    bodyEl.querySelector('#owner-promo-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = bodyEl.querySelector('#owner-promo-result');
      out.innerHTML = '<p class="ai-loading-text">Generating campaign...</p>';
      try {
        const res = await apiFetch('/api/ai/promo', {
          method: 'POST',
          body: JSON.stringify({
            campaignGoal: bodyEl.querySelector('#promo-goal').value,
            targetDish: bodyEl.querySelector('#promo-dish').value,
          }),
        });
        out.innerHTML = `<div class="ai-insight-box"><strong>${escapeAttr(res.headline)}</strong><p><em>Subject:</em> ${escapeAttr(res.emailSubject)}</p><p>${escapeAttr(res.socialCaption)}</p><p><strong>SMS:</strong> ${escapeAttr(res.smsSnippet)}</p></div>`;
      } catch (err) {
        out.innerHTML = `<p class="form-status error">${escapeAttr(err.message)}</p>`;
      }
    });

    bodyEl.querySelector('#owner-biz-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = bodyEl.querySelector('#owner-biz-result');
      out.innerHTML = '<p class="ai-loading-text">Analyzing operations...</p>';
      try {
        const res = await apiFetch('/api/ai/business-assistant', {
          method: 'POST',
          body: JSON.stringify({ question: bodyEl.querySelector('#biz-question').value }),
        });
        out.innerHTML = `<div class="ai-insight-box"><p>${escapeAttr(res.answer)}</p><p><strong>Action Plan:</strong> ${(res.actionPlan || []).map(escapeAttr).join(' · ')}</p></div>`;
      } catch (err) {
        out.innerHTML = `<p class="form-status error">${escapeAttr(err.message)}</p>`;
      }
    });

    bodyEl.querySelector('#owner-forecast-btn')?.addEventListener('click', async () => {
      const out = bodyEl.querySelector('#owner-biz-result');
      out.innerHTML = '<p class="ai-loading-text">Computing demand forecast...</p>';
      try {
        const res = await apiFetch('/api/ai/forecast', { method: 'POST', body: '{}' });
        out.innerHTML = `<div class="ai-insight-box"><strong>Peak Window: ${escapeAttr(res.predictedPeakWindow)}</strong><p>${escapeAttr(res.summary)}</p><p><strong>High Demand:</strong> ${(res.highDemandDishes || []).map(escapeAttr).join(', ')}</p><p><strong>Staffing:</strong> ${escapeAttr(res.staffingAdvice)}</p></div>`;
      } catch (err) {
        out.innerHTML = `<p class="form-status error">${escapeAttr(err.message)}</p>`;
      }
    });

    bodyEl.querySelector('#owner-staff-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await apiFetch('/api/owner/staff', {
        method: 'POST',
        body: JSON.stringify({
          name: bodyEl.querySelector('#stf-name').value,
          role: bodyEl.querySelector('#stf-role').value,
        }),
      });
      loadAndRender();
    });

    bodyEl.querySelector('#owner-settings-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await apiFetch('/api/owner/settings', {
        method: 'PUT',
        body: JSON.stringify({
          taxRate: Number(bodyEl.querySelector('#set-tax').value),
          deliveryFee: Number(bodyEl.querySelector('#set-fee').value),
          acceptingOrders: bodyEl.querySelector('#set-orders').checked,
          acceptingReservations: bodyEl.querySelector('#set-res').checked,
        }),
      });
      bodyEl.querySelector('#set-status').textContent = 'Saved!';
    });
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.getAttribute('data-owner-tab');
      tabBtns.forEach((b) => b.classList.toggle('active', b === btn));
      renderActiveTab();
    });
  });

  closeBtn?.addEventListener('click', closeModal);

  return {
    openModal,
    closeModal,
  };
}
