import QRCode from 'qrcode';
import { buildLowStockNotifications, evaluateInventoryStock } from './inventory-alerts.js';
import {
  computeDailySpecialSavingsPct,
  formatDailySpecialRemaining,
  isDailySpecialActive,
} from './daily-specials.js';
import {
  DEFAULT_TABLE_PRESETS,
  FLOOR_PLAN_TABLES,
  buildTableMenuUrl,
  normalizeTableLabel,
} from './qr-tools.js';
import { computeLoyaltyAnalytics } from './loyalty-analytics.js';
import {
  renderGuestDemographicsChart,
  renderLoyaltyTrendsChart,
} from './owner-loyalty-charts.js';

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
  onInventorySyncToFirestore,
  onInventoryDeleteFromFirestore,
  onReservationsMutated,
  onTableSessionSyncToFirestore,
  onTableReleaseFromFirestore,
  onOpenTablePreview,
}) {
  const modal = document.querySelector('#owner-dashboard-modal');
  const closeBtn = document.querySelector('#close-owner-modal');
  const tabBtns = document.querySelectorAll('[data-owner-tab]');
  const invAlertBadge = document.querySelector('#owner-inv-alert-badge');
  const bodyEl = document.querySelector('#owner-tab-content');

  let activeTab = 'overview';
  let snapshot = null;
  let editingDishId = null;
  let menuFilterText = '';
  let menuFilterCategory = 'all';
  let invFilterMode = 'all';
  let showDismissedAlerts = false;
  let lastInvFeedback = '';
  let lastMenuFeedback = '';
  let reservationsSubView = 'floor-plan';
  let floorSeatTargetId = '';
  let reservationsFeedback = '';

  let qrTablePreset = 'Table 05';
  let qrTableCustom = '';
  let qrBaseOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:3000';
  let qrHeadline = 'Scan to Browse Menu & Order';
  let qrSubcopy = 'Live digital menu · Customise dishes & order direct to your table';
  let qrRenderSeq = 0;
  let qrLatestSvgMarkup = '';
  let qrLatestPngDataUrl = '';
  let loyaltyTrendRange = 'all';
  let loyaltyTrendMode = 'flow';
  let guestDemoDimension = 'tier';
  let loyaltyFetchSeq = 0;

  function updateInventoryTabBadge(summary) {
    if (!invAlertBadge) return;
    const activeCount = Number(summary?.activeAlertCount ?? 0);
    if (activeCount > 0) {
      invAlertBadge.textContent = String(activeCount);
      invAlertBadge.hidden = false;
    } else {
      invAlertBadge.textContent = '0';
      invAlertBadge.hidden = true;
    }
  }

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
      const alertSummary = snapshot.inventoryAlertSummary || buildLowStockNotifications(snapshot.inventory || []);
      updateInventoryTabBadge(alertSummary);
      renderActiveTab();
    } catch (err) {
      bodyEl.innerHTML = `<p class="form-status error">${escapeAttr(err.message)}</p>`;
    }
  }

  function renderActiveTab() {
    if (!bodyEl || !snapshot) return;
    const alertSummary = snapshot.inventoryAlertSummary || buildLowStockNotifications(snapshot.inventory || []);
    updateInventoryTabBadge(alertSummary);
    if (activeTab === 'overview') return renderOverview();
    if (activeTab === 'menu') return renderMenuManager();
    if (activeTab === 'orders') return renderOrdersManager();
    if (activeTab === 'reservations') return renderReservationsManager();
    if (activeTab === 'inventory') return renderInventoryManager();
    if (activeTab === 'crm') return renderCrmAndReviews();
    if (activeTab === 'ai-studio') return renderAiStudioAndSettings();
    if (activeTab === 'tools') return renderOwnerTools();
  }

  function getActiveLoyaltyAnalytics() {
    if (
      loyaltyTrendRange === 'all' &&
      guestDemoDimension === 'tier' &&
      snapshot?.loyaltyAnalytics
    ) {
      return snapshot.loyaltyAnalytics;
    }
    return computeLoyaltyAnalytics(
      {
        users: (snapshot?.customers || []).map((c) => ({ ...c, role: 'customer' })),
        orders: snapshot?.orders || [],
        reviews: snapshot?.reviews || [],
      },
      { range: loyaltyTrendRange, segmentBy: guestDemoDimension }
    );
  }

  function renderLoyaltyVizHtml(loyaltyData) {
    const summary = loyaltyData?.trends?.summary || {
      totalEarned: 0,
      totalRedeemed: 0,
      activeBalance: 0,
      avgPerGuest: 0,
      redemptionRatePct: 0,
    };
    const demo = loyaltyData?.demographics || { totalMembers: 0, avgOrdersPerGuest: 0 };

    return `
      <section class="owner-loyalty-viz-section" aria-label="Loyalty point trends and guest demographics">
        <div class="owner-two-col">
          <div class="owner-card d3-panel-card">
            <div class="d3-panel-head">
              <div>
                <h4>Loyalty Point Trends</h4>
                <p class="d3-panel-sub tabular-nums" data-trends-sub>
                  ${Number(summary.totalEarned || 0).toLocaleString('en-IN')} earned · ${Number(summary.totalRedeemed || 0).toLocaleString('en-IN')} redeemed · ${summary.redemptionRatePct || 0}% redemption
                </p>
              </div>
              <div class="d3-controls-cluster">
                <div class="d3-seg-group" role="group" aria-label="Loyalty trend series mode">
                  <button type="button" class="d3-seg-btn ${loyaltyTrendMode === 'flow' ? 'active' : ''}" data-loyalty-mode="flow">Flow</button>
                  <button type="button" class="d3-seg-btn ${loyaltyTrendMode === 'cumulative' ? 'active' : ''}" data-loyalty-mode="cumulative">Cumulative</button>
                </div>
                <div class="d3-seg-group" role="group" aria-label="Loyalty trend time range">
                  <button type="button" class="d3-seg-btn ${loyaltyTrendRange === '30d' ? 'active' : ''}" data-loyalty-range="30d">30D</button>
                  <button type="button" class="d3-seg-btn ${loyaltyTrendRange === '90d' ? 'active' : ''}" data-loyalty-range="90d">90D</button>
                  <button type="button" class="d3-seg-btn ${loyaltyTrendRange === 'all' ? 'active' : ''}" data-loyalty-range="all">All</button>
                </div>
              </div>
            </div>
            <div class="d3-legend-row" aria-hidden="true">
              ${
                loyaltyTrendMode === 'cumulative'
                  ? '<span><i class="d3-swatch-dot is-forest"></i>Cumulative Earned Points</span>'
                  : '<span><i class="d3-swatch-dot is-forest"></i>Earned Points</span><span><i class="d3-swatch-dot is-gold-dashed"></i>Redeemed Points</span>'
              }
              <span class="tabular-nums d3-legend-stat">Avg ${Number(summary.avgPerGuest || 0).toLocaleString('en-IN')} pts / guest</span>
            </div>
            <div id="owner-d3-loyalty-trends" data-testid="d3-loyalty-trends"></div>
          </div>

          <div class="owner-card d3-panel-card">
            <div class="d3-panel-head">
              <div>
                <h4>Top Guest Demographics</h4>
                <p class="d3-panel-sub tabular-nums" data-demo-sub>
                  ${demo.totalMembers || 0} CRM members · Avg ${demo.avgOrdersPerGuest || 0} visits / guest
                </p>
              </div>
              <div class="d3-seg-group" role="group" aria-label="Demographic breakdown dimension">
                <button type="button" class="d3-seg-btn ${guestDemoDimension === 'tier' ? 'active' : ''}" data-demo-dim="tier">Tier</button>
                <button type="button" class="d3-seg-btn ${guestDemoDimension === 'neighborhood' ? 'active' : ''}" data-demo-dim="neighborhood">Area</button>
                <button type="button" class="d3-seg-btn ${guestDemoDimension === 'preference' ? 'active' : ''}" data-demo-dim="preference">Taste</button>
              </div>
            </div>
            <div id="owner-d3-guest-demographics" data-testid="d3-guest-demographics"></div>
          </div>
        </div>
      </section>
    `;
  }

  function mountLoyaltyVisualizations(initialData) {
    const trendsHost = bodyEl.querySelector('#owner-d3-loyalty-trends');
    const demoHost = bodyEl.querySelector('#owner-d3-guest-demographics');
    if (!trendsHost || !demoHost) return;

    function syncPanelSubtitles(data) {
      const s = data?.trends?.summary || {};
      const d = data?.demographics || {};
      const trendsSubEl = bodyEl.querySelector('[data-trends-sub]');
      const demoSubEl = bodyEl.querySelector('[data-demo-sub]');
      if (trendsSubEl) {
        const earnedVal = loyaltyTrendRange === 'all' ? (s.totalEarned || 0) : (s.windowEarned ?? s.totalEarned ?? 0);
        const redeemedVal = loyaltyTrendRange === 'all' ? (s.totalRedeemed || 0) : (s.windowRedeemed ?? s.totalRedeemed ?? 0);
        const rate = loyaltyTrendRange === 'all'
          ? (s.redemptionRatePct || 0)
          : (earnedVal > 0 ? Math.round((redeemedVal / earnedVal) * 100) : 0);
        const windowNote = loyaltyTrendRange === 'all' ? '' : ` (${loyaltyTrendRange.toUpperCase()})`;
        trendsSubEl.textContent = `${Number(earnedVal).toLocaleString('en-IN')} earned · ${Number(redeemedVal).toLocaleString('en-IN')} redeemed · ${rate}% redemption${windowNote}`;
      }
      if (demoSubEl) {
        const dimLabel = guestDemoDimension === 'neighborhood' ? 'area' : guestDemoDimension === 'preference' ? 'taste' : 'tier';
        demoSubEl.textContent = `${d.totalMembers || 0} CRM members · Avg ${d.avgOrdersPerGuest || 0} visits · by ${dimLabel}`;
      }
    }

    let currentData = initialData || getActiveLoyaltyAnalytics();
    syncPanelSubtitles(currentData);
    renderLoyaltyTrendsChart(trendsHost, currentData.trends, { mode: loyaltyTrendMode });
    renderGuestDemographicsChart(demoHost, currentData.demographics);

    async function refreshFromFilters() {
      const seq = ++loyaltyFetchSeq;
      const fallback = getActiveLoyaltyAnalytics();
      currentData = fallback;
      syncPanelSubtitles(fallback);
      renderLoyaltyTrendsChart(trendsHost, fallback.trends, { mode: loyaltyTrendMode });
      renderGuestDemographicsChart(demoHost, fallback.demographics);
      try {
        const res = await apiFetch(
          `/api/owner/loyalty-analytics?range=${encodeURIComponent(loyaltyTrendRange)}&segmentBy=${encodeURIComponent(guestDemoDimension)}`
        );
        if (seq !== loyaltyFetchSeq || !bodyEl.contains(trendsHost)) return;
        currentData = res;
        syncPanelSubtitles(res);
        renderLoyaltyTrendsChart(trendsHost, res.trends, { mode: loyaltyTrendMode });
        renderGuestDemographicsChart(demoHost, res.demographics);
      } catch {
        // Retain client-computed series if request fails transiently
      }
    }

    bodyEl.querySelectorAll('[data-loyalty-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        loyaltyTrendMode = btn.getAttribute('data-loyalty-mode') === 'cumulative' ? 'cumulative' : 'flow';
        bodyEl.querySelectorAll('[data-loyalty-mode]').forEach((b) =>
          b.classList.toggle('active', b.getAttribute('data-loyalty-mode') === loyaltyTrendMode)
        );
        const legendEl = bodyEl.querySelector('.d3-legend-row');
        if (legendEl) {
          const avgPts = Number(currentData?.trends?.summary?.avgPerGuest || 0).toLocaleString('en-IN');
          legendEl.innerHTML = `
            ${
              loyaltyTrendMode === 'cumulative'
                ? '<span><i class="d3-swatch-dot is-forest"></i>Cumulative Earned Points</span>'
                : '<span><i class="d3-swatch-dot is-forest"></i>Earned Points</span><span><i class="d3-swatch-dot is-gold-dashed"></i>Redeemed Points</span>'
            }
            <span class="tabular-nums d3-legend-stat">Avg ${avgPts} pts / guest</span>
          `;
        }
        renderLoyaltyTrendsChart(trendsHost, currentData.trends, { mode: loyaltyTrendMode });
      });
    });

    bodyEl.querySelectorAll('[data-loyalty-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        loyaltyTrendRange = btn.getAttribute('data-loyalty-range') || 'all';
        bodyEl.querySelectorAll('[data-loyalty-range]').forEach((b) =>
          b.classList.toggle('active', b.getAttribute('data-loyalty-range') === loyaltyTrendRange)
        );
        refreshFromFilters();
      });
    });

    bodyEl.querySelectorAll('[data-demo-dim]').forEach((btn) => {
      btn.addEventListener('click', () => {
        guestDemoDimension = btn.getAttribute('data-demo-dim') || 'tier';
        bodyEl.querySelectorAll('[data-demo-dim]').forEach((b) =>
          b.classList.toggle('active', b.getAttribute('data-demo-dim') === guestDemoDimension)
        );
        refreshFromFilters();
      });
    });
  }

  function renderOverview() {
    const a = snapshot.analytics;
    const alertSummary = snapshot.inventoryAlertSummary || buildLowStockNotifications(snapshot.inventory || []);
    const maxCatRev = Math.max(1, ...(a.categoryBreakdown || []).map((c) => c.revenue));
    const loyaltyData = getActiveLoyaltyAnalytics();

    bodyEl.innerHTML = `
      <div class="owner-kpi-grid">
        <div class="owner-kpi"><span>Total Revenue</span><strong class="tabular-nums">${formatRupees(a.totalRevenue, { decimals: true })}</strong></div>
        <div class="owner-kpi"><span>Orders (${a.activeOrders} active)</span><strong class="tabular-nums">${a.totalOrders}</strong></div>
        <div class="owner-kpi"><span>Avg Order Value</span><strong class="tabular-nums">${formatRupees(a.avgOrderValue, { decimals: true })}</strong></div>
        <div class="owner-kpi"><span>Reservations</span><strong class="tabular-nums">${a.upcomingReservations} upcoming</strong></div>
        <div class="owner-kpi"><span>Guest Rating</span><strong class="tabular-nums">${a.averageRating} / 5 (${a.reviewCount})</strong></div>
        <button type="button" class="owner-kpi owner-kpi-btn ${alertSummary.totalAlertCount > 0 ? 'kpi-warn' : ''}" data-jump-tab="inventory">
          <span>Low Stock Alerts</span>
          <strong class="tabular-nums">${alertSummary.totalAlertCount} ${alertSummary.activeAlertCount > 0 ? `(${alertSummary.activeAlertCount} new)` : ''}</strong>
        </button>
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
            alertSummary.totalAlertCount > 0
              ? `<div class="stock-alert-box">
                  <div><strong>Automated Low-Stock Watch:</strong> ${alertSummary.allAlerts.map((i) => `${escapeAttr(i.name)} (${i.stockQty}/${i.reorderLevel} ${escapeAttr(i.unit)})`).join(' · ')}</div>
                  <button type="button" class="btn-outline-sm" data-jump-tab="inventory">Review &amp; Restock</button>
                </div>`
              : ''
          }
        </div>
      </div>
      ${renderLoyaltyVizHtml(loyaltyData)}
    `;

    mountLoyaltyVisualizations(loyaltyData);

    bodyEl.querySelectorAll('[data-jump-tab]').forEach((el) => {
      el.addEventListener('click', () => {
        activeTab = el.getAttribute('data-jump-tab') || 'inventory';
        tabBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-owner-tab') === activeTab));
        renderActiveTab();
      });
    });
  }

  function renderMenuManager() {
    const items = getMenuItems() || [];
    const editingItem = editingDishId ? items.find((m) => m.id === editingDishId) : null;
    const unpricedCount = items.filter((m) => m.price === null || m.price === undefined || Number(m.price) <= 0).length;
    const dailySpecialCount = items.filter((m) => isDailySpecialActive(m)).length;
    const editingSpecialActive = editingItem ? isDailySpecialActive(editingItem) : false;
    const editingSuggestedSpecial =
      editingItem?.dailySpecialPrice ??
      (editingItem?.price && Number(editingItem.price) > 1
        ? Math.max(1, Math.round(Number(editingItem.price) * 0.85))
        : '');

    const filteredItems = items.filter((m) => {
      const hasPrice = m.price !== null && m.price !== undefined && Number(m.price) > 0;
      if (menuFilterCategory === 'unpriced' && hasPrice) return false;
      if (menuFilterCategory === 'daily-special' && !isDailySpecialActive(m)) return false;
      if (menuFilterCategory === 'other' && ['Coffee', 'Croissants', 'Bakery & Desserts'].includes(m.category)) return false;
      if (!['all', 'unpriced', 'daily-special', 'other'].includes(menuFilterCategory) && m.category !== menuFilterCategory) return false;
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
            <label>Combo Variant Price (₹ INR — optional)
              <input type="number" step="1" min="1" max="100000" id="om-combo-price" value="${editingItem?.comboPrice ?? ''}" placeholder="e.g. 319">
            </label>
            <label>Combo Pairing Label (optional)
              <input type="text" maxlength="100" id="om-combo-label" value="${escapeAttr(editingItem?.comboLabel || '')}" placeholder="e.g. With Fries &amp; Iced Cola">
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
            <label>Food Image Path or Upload <input type="text" id="om-image" value="${escapeAttr(editingItem?.imageUrl || '/src/assets/optimized/hot-coffee.webp')}"></label>
            <label>Upload Food Photo <input type="file" id="om-image-file" accept="image/png,image/jpeg,image/webp"></label>
          </div>

          <div class="owner-checkbox-row">
            <label><input type="checkbox" id="om-available" ${editingItem?.available !== false ? 'checked' : ''}> Available</label>
            <label><input type="checkbox" id="om-bestseller" ${editingItem?.isBestseller || editingItem?.isPopular ? 'checked' : ''}> Bestseller</label>
            <label><input type="checkbox" id="om-new" ${editingItem ? (editingItem.isNewArrival || editingItem.isNew ? 'checked' : '') : 'checked'}> New Arrival</label>
            <label><input type="checkbox" id="om-recommended" ${editingItem?.isRecommended ? 'checked' : ''}> Recommended</label>
          </div>

          <div class="owner-daily-special-box">
            <div class="owner-daily-special-head">
              <label><input type="checkbox" id="om-daily-special" ${editingSpecialActive ? 'checked' : ''}> Feature as 24-Hour Daily Special</label>
              ${
                editingSpecialActive
                  ? `<span class="special-active-tag is-on tabular-nums">${escapeAttr(formatDailySpecialRemaining(editingItem))} · ${computeDailySpecialSavingsPct(editingItem)}% off</span>`
                  : '<span class="special-active-tag is-off">24h Auto-Expiry</span>'
              }
            </div>
            <label>Daily Special Promo Price (₹ INR — must be lower than regular price)
              <input type="number" step="1" min="1" max="100000" id="om-daily-special-price" value="${escapeAttr(editingSuggestedSpecial)}" placeholder="e.g. 219">
            </label>
          </div>

          <button type="submit" class="btn-forest">${editingItem ? 'Save Food Item Changes' : 'Add to Food Items'}</button>
          <p id="om-form-status" class="form-status"></p>
        </form>

        <div class="owner-card">
          <div class="owner-card-head">
            <h4>Unified Food Items (${items.length} total · ${dailySpecialCount} daily specials · ${unpricedCount} awaiting ₹)</h4>
          </div>
          <div class="owner-filter-bar">
            <input type="search" id="om-filter-search" value="${escapeAttr(menuFilterText)}" placeholder="Filter Food Items by name, subcategory...">
            <select id="om-filter-category">
              <option value="all" ${menuFilterCategory === 'all' ? 'selected' : ''}>All Food Items (${items.length})</option>
              <option value="daily-special" ${menuFilterCategory === 'daily-special' ? 'selected' : ''}>24h Daily Specials (${dailySpecialCount})</option>
              <option value="unpriced" ${menuFilterCategory === 'unpriced' ? 'selected' : ''}>Awaiting ₹ Price (${unpricedCount})</option>
              <option value="Coffee" ${menuFilterCategory === 'Coffee' ? 'selected' : ''}>Coffee</option>
              <option value="Croissants" ${menuFilterCategory === 'Croissants' ? 'selected' : ''}>Croissants</option>
              <option value="Bakery & Desserts" ${menuFilterCategory === 'Bakery & Desserts' ? 'selected' : ''}>Bakery &amp; Desserts</option>
              <option value="other" ${menuFilterCategory === 'other' ? 'selected' : ''}>Mains, Burgers &amp; Combos</option>
            </select>
          </div>
          <p id="om-inline-status" class="form-status ${lastMenuFeedback ? 'success' : ''}" aria-live="polite">${escapeAttr(lastMenuFeedback)}</p>
          <div class="owner-table-wrap owner-food-table-scroll">
            <table class="owner-table">
              <thead>
                <tr>
                  <th>Food Item</th>
                  <th>Category / Subcategory</th>
                  <th>Price (₹) &amp; Offer (₹)</th>
                  <th>Daily Special (24h)</th>
                  <th>Stock &amp; Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filteredItems
                  .map((m) => {
                    const isUnpriced = m.price === null || m.price === undefined || Number(m.price) <= 0;
                    const specialActive = isDailySpecialActive(m);
                    const remainingLabel = specialActive ? formatDailySpecialRemaining(m) : '';
                    const savingsPct = specialActive ? computeDailySpecialSavingsPct(m) : 0;
                    const suggestedPromo = !isUnpriced
                      ? m.dailySpecialPrice ?? Math.max(1, Math.round(Number(m.price) * 0.85))
                      : '';
                    const tags = [
                      m.isBestseller || m.isPopular ? 'Bestseller' : '',
                      m.isNewArrival || m.isNew ? 'New' : '',
                      m.isRecommended ? 'Rec' : '',
                    ]
                      .filter(Boolean)
                      .join(' · ');
                    return `
                  <tr class="${specialActive ? 'row-daily-special' : isUnpriced ? 'row-pending-price' : ''}">
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
                      <div class="inline-special-editor">
                        <span class="special-active-tag ${specialActive ? 'is-on' : 'is-off'} tabular-nums">
                          ${specialActive ? `24h Active · ${escapeAttr(remainingLabel)} (${savingsPct}% off)` : 'Off'}
                        </span>
                        <div class="inline-special-controls">
                          <input
                            type="number"
                            min="1"
                            max="100000"
                            step="1"
                            class="inline-rupee-input"
                            data-inline-special-price="${escapeAttr(m.id)}"
                            value="${escapeAttr(suggestedPromo)}"
                            placeholder="Promo ₹"
                            aria-label="Daily Special 24-hour promo price in rupees for ${escapeAttr(m.name)}"
                            ${isUnpriced ? 'disabled' : ''}
                          >
                          ${
                            specialActive
                              ? `<button type="button" class="btn-gold-sm" data-update-daily-special="${escapeAttr(m.id)}">Update ₹</button>
                                 <button type="button" class="btn-outline-sm" data-toggle-daily-special="${escapeAttr(m.id)}" data-enable="false">Turn Off</button>`
                              : `<button type="button" class="btn-forest btn-sm-inline" data-toggle-daily-special="${escapeAttr(m.id)}" data-enable="true" ${isUnpriced ? 'disabled title="Set a regular ₹ price first"' : ''}>Feature 24h</button>`
                          }
                        </div>
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
    lastMenuFeedback = '';

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
      const rawComboPrice = bodyEl.querySelector('#om-combo-price')?.value.trim() ?? '';
      const comboLabel = bodyEl.querySelector('#om-combo-label')?.value.trim() ?? '';
      const isBestseller = bodyEl.querySelector('#om-bestseller').checked;
      const isNewArrival = bodyEl.querySelector('#om-new').checked;
      const stockStatus = bodyEl.querySelector('#om-stock-status').value;

      const isDailySpecial = Boolean(bodyEl.querySelector('#om-daily-special')?.checked);
      const rawDailySpecialPrice = bodyEl.querySelector('#om-daily-special-price')?.value.trim() ?? '';

      const payload = {
        name: bodyEl.querySelector('#om-name').value,
        category: bodyEl.querySelector('#om-category').value,
        subcategory: bodyEl.querySelector('#om-subcategory').value,
        showcaseSection: bodyEl.querySelector('#om-section').value,
        price: rawPrice === '' ? null : Number(rawPrice),
        discountPrice: rawDiscount === '' ? null : Number(rawDiscount),
        comboPrice: rawComboPrice === '' ? null : Number(rawComboPrice),
        comboLabel,
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
        isDailySpecial,
        dailySpecialPrice: rawDailySpecialPrice === '' ? null : Number(rawDailySpecialPrice),
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
          lastMenuFeedback = savedRes.item.isDailySpecial
            ? `Saved ${savedRes.item.name} with active 24h Daily Special (${formatRupees(savedRes.item.dailySpecialPrice)}).`
            : `Saved ${savedRes.item.name}.`;
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

    // Inline Daily Special (24h Toggle & Promo ₹ Update)
    async function submitDailySpecialToggle(id, enabled) {
      const inlineStatus = bodyEl.querySelector('#om-inline-status');
      const promoInput = bodyEl.querySelector(`[data-inline-special-price="${CSS.escape(id)}"]`);
      const promoVal = promoInput?.value.trim() ?? '';
      try {
        const res = await apiFetch(`/api/owner/menu/${encodeURIComponent(id)}/daily-special`, {
          method: 'PATCH',
          body: JSON.stringify({
            enabled,
            dailySpecialPrice: promoVal === '' ? null : Number(promoVal),
            durationHours: 24,
          }),
        });
        if (res?.item) {
          onMenuSyncToFirestore?.(res.item).catch(() => {});
          lastMenuFeedback = enabled
            ? `${res.item.name} featured as a 24-hour Daily Special at ${formatRupees(res.item.dailySpecialPrice)}.`
            : `Removed ${res.item.name} from Daily Specials.`;
        }
        await onMenuMutated?.();
        await loadAndRender();
      } catch (err) {
        if (inlineStatus) {
          inlineStatus.textContent = err.message;
          inlineStatus.className = 'form-status error';
        }
      }
    }

    bodyEl.querySelectorAll('[data-toggle-daily-special]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-toggle-daily-special');
        const enable = btn.getAttribute('data-enable') === 'true';
        submitDailySpecialToggle(id, enable);
      });
    });

    bodyEl.querySelectorAll('[data-update-daily-special]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-update-daily-special');
        submitDailySpecialToggle(id, true);
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
                      <td>
                        <strong>${escapeAttr(o.id)}</strong><br>
                        <small>${escapeAttr(o.orderType.replace(/_/g, ' '))}${o.tableNumber ? ` · <strong class="order-table-tag">${escapeAttr(o.tableNumber)}</strong>` : ''}</small>
                      </td>
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

  function formatTableSourceLabel(source) {
    if (source === 'qr_scanner') return 'QR Concierge Scanner';
    if (source === 'qr_link') return 'Table QR Scan';
    if (source === 'dine_in_order') return 'Dine-In QR Order';
    if (source === 'owner_manual') return 'Host Seated';
    return 'Active Session';
  }

  function formatCheckinTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function renderFloorSeatPips(seats = 4) {
    const count = Math.max(2, Math.min(8, Number(seats) || 4));
    return `<div class="floor-seat-pips" aria-hidden="true">${Array.from({ length: count }, () => '<span></span>').join('')}</div>`;
  }

  function renderReservationsManager() {
    const resList = snapshot.reservations || [];
    const statuses = ['confirmed', 'seated', 'completed', 'cancelled'];
    const floorPlan = snapshot.floorPlan || {
      tables: FLOOR_PLAN_TABLES.map((t) => ({ ...t, status: 'available', activeOrders: [] })),
      summary: {
        totalTables: FLOOR_PLAN_TABLES.length,
        occupiedCount: 0,
        qrCheckedInCount: 0,
        reservedCount: 0,
        availableCount: FLOOR_PLAN_TABLES.length,
        totalSeats: FLOOR_PLAN_TABLES.reduce((s, t) => s + t.seats, 0),
        occupiedSeats: 0,
      },
    };
    const summary = floorPlan.summary || {};
    const tables = floorPlan.tables || [];

    const zonesOrder = ['Main Dining', 'Open Courtyard', 'Lounge', 'Custom Seating'];
    const zoneNames = [
      ...zonesOrder.filter((z) => tables.some((t) => t.zone === z)),
      ...new Set(tables.map((t) => t.zone).filter((z) => !zonesOrder.includes(z))),
    ];

    const floorPlanHtml = `
      <div class="floor-kpi-strip">
        <div class="floor-kpi is-qr">
          <span>QR Checked-In</span>
          <strong class="tabular-nums">${summary.qrCheckedInCount ?? 0}</strong>
        </div>
        <div class="floor-kpi is-occupied">
          <span>Occupied Tables</span>
          <strong class="tabular-nums">${summary.occupiedCount ?? 0} / ${summary.totalTables ?? tables.length}</strong>
        </div>
        <div class="floor-kpi is-reserved">
          <span>Reserved</span>
          <strong class="tabular-nums">${summary.reservedCount ?? 0}</strong>
        </div>
        <div class="floor-kpi is-available">
          <span>Open Tables</span>
          <strong class="tabular-nums">${summary.availableCount ?? tables.length}</strong>
        </div>
        <div class="floor-kpi">
          <span>Available Seats</span>
          <strong class="tabular-nums">${Math.max(0, (summary.totalSeats ?? 0) - (summary.occupiedSeats ?? 0))} / ${summary.totalSeats ?? 0}</strong>
        </div>
      </div>

      <div class="floor-legend" aria-label="Floor plan status legend">
        <span class="floor-legend-item"><i class="floor-dot is-qr"></i> QR Scanner Checked-In</span>
        <span class="floor-legend-item"><i class="floor-dot is-occupied"></i> Occupied / Dine-In Order</span>
        <span class="floor-legend-item"><i class="floor-dot is-reserved"></i> Reserved Booking</span>
        <span class="floor-legend-item"><i class="floor-dot is-available"></i> Available Table</span>
      </div>

      <div class="floor-zones-stack">
        ${zoneNames
          .map((zone) => {
            const zoneTables = tables.filter((t) => t.zone === zone);
            return `
              <section class="floor-zone-block">
                <div class="floor-zone-head">
                  <h5>${escapeAttr(zone)}</h5>
                  <span class="tabular-nums">${zoneTables.filter((t) => t.status === 'occupied').length} / ${zoneTables.length} occupied</span>
                </div>
                <div class="floor-plan-grid">
                  ${zoneTables
                    .map((tbl) => {
                      const isOccupied = tbl.status === 'occupied';
                      const isReserved = tbl.status === 'reserved';
                      const isQr = Boolean(tbl.checkedInViaQr);
                      const statusClass = isOccupied
                        ? isQr
                          ? 'is-occupied is-qr-checkin'
                          : 'is-occupied'
                        : isReserved
                          ? 'is-reserved'
                          : 'is-available';
                      const statusBadge = isOccupied
                        ? isQr
                          ? 'QR Checked-In'
                          : 'Occupied'
                        : isReserved
                          ? 'Reserved'
                          : 'Available';
                      const activeOrders = Array.isArray(tbl.activeOrders) ? tbl.activeOrders : [];
                      const isSeatingThis = floorSeatTargetId === tbl.id;

                      return `
                        <article class="floor-table-card ${statusClass}" data-floor-table="${escapeAttr(tbl.id)}">
                          <div class="floor-table-top">
                            <div>
                              <strong>${escapeAttr(tbl.label)}</strong>
                              <span class="floor-seat-cap tabular-nums">${tbl.seats}-Top · ${escapeAttr(tbl.shape || 'square')}</span>
                            </div>
                            <span class="floor-status-chip ${statusClass}">
                              ${isQr ? '<span class="qr-checkin-dot" aria-hidden="true"></span>' : ''}
                              ${statusBadge}
                            </span>
                          </div>

                          ${renderFloorSeatPips(tbl.seats)}

                          <div class="floor-table-details">
                            ${
                              isOccupied
                                ? `
                                  <div class="floor-guest-name">${escapeAttr(tbl.guestName || 'Seated Guest')}</div>
                                  <div class="floor-meta-line tabular-nums">
                                    <span>${escapeAttr(formatTableSourceLabel(tbl.source))}</span>
                                    ${tbl.checkedInAt ? ` · <span>In ${escapeAttr(formatCheckinTime(tbl.checkedInAt))}</span>` : ''}
                                  </div>
                                  ${
                                    activeOrders.length > 0
                                      ? `<div class="floor-order-tag tabular-nums">
                                          <i class="fa-solid fa-receipt"></i>
                                          ${activeOrders.length} active ${activeOrders.length === 1 ? 'order' : 'orders'} (${activeOrders.map((o) => o.id).join(', ')})
                                        </div>`
                                      : '<div class="floor-meta-line">No kitchen ticket yet</div>'
                                  }
                                `
                                : isReserved && tbl.reservation
                                  ? `
                                    <div class="floor-guest-name">${escapeAttr(tbl.reservation.name)}</div>
                                    <div class="floor-meta-line tabular-nums">${escapeAttr(tbl.reservation.date)} · ${escapeAttr(tbl.reservation.time)} · ${tbl.reservation.partySize} guests</div>
                                  `
                                  : '<div class="floor-meta-line">Ready for walk-in or QR scan check-in</div>'
                            }
                          </div>

                          ${
                            isSeatingThis && !isOccupied
                              ? `
                                <form class="floor-quick-seat-form" data-seat-form="${escapeAttr(tbl.label)}">
                                  <input type="text" name="guestName" placeholder="Guest name" required value="${escapeAttr(tbl.reservation?.name || '')}">
                                  <div class="floor-quick-seat-actions">
                                    <button type="submit" class="btn-forest btn-sm-inline">Confirm Seat</button>
                                    <button type="button" class="btn-outline-sm" data-cancel-seat>Cancel</button>
                                  </div>
                                </form>
                              `
                              : `
                                <div class="floor-table-actions">
                                  ${
                                    isOccupied
                                      ? `
                                        <button type="button" class="btn-outline-sm" data-release-table="${escapeAttr(tbl.id)}">Release Table</button>
                                        ${
                                          activeOrders.length > 0
                                            ? '<button type="button" class="btn-gold-sm" data-jump-orders>Orders</button>'
                                            : `<button type="button" class="btn-outline-sm" data-open-qr-for-table="${escapeAttr(tbl.label)}">QR</button>`
                                        }
                                      `
                                      : `
                                        <button type="button" class="btn-forest btn-sm-inline" data-start-seat="${escapeAttr(tbl.id)}">Seat Guest</button>
                                        <button type="button" class="btn-outline-sm" data-open-qr-for-table="${escapeAttr(tbl.label)}">QR Card</button>
                                      `
                                  }
                                </div>
                              `
                          }
                        </article>
                      `;
                    })
                    .join('')}
                </div>
              </section>
            `;
          })
          .join('')}
      </div>
    `;

    const listHtml =
      resList.length === 0
        ? '<p class="muted-empty">No table reservations recorded yet.</p>'
        : `<div class="owner-table-wrap"><table class="owner-table">
            <thead><tr><th>ID</th><th>Guest</th><th>Date &amp; Time</th><th>Party</th><th>Assigned Table</th><th>Status</th></tr></thead>
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
                    <select data-res-table="${escapeAttr(r.id)}" aria-label="Assign table for reservation ${escapeAttr(r.id)}">
                      <option value="">Unassigned</option>
                      ${FLOOR_PLAN_TABLES.map(
                        (t) => `<option value="${escapeAttr(t.label)}" ${r.tableLabel === t.label ? 'selected' : ''}>${escapeAttr(t.label)} (${t.seats}-Top)</option>`
                      ).join('')}
                    </select>
                  </td>
                  <td>
                    <select data-res-status="${escapeAttr(r.id)}">
                      ${statuses.map((s) => `<option value="${s}" ${r.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                  </td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table></div>`;

    bodyEl.innerHTML = `
      <div class="owner-card">
        <div class="owner-card-head res-manager-head">
          <div>
            <h4>Floor Plan &amp; Reservations</h4>
            <p class="qr-card-sub">Live Pier 25 dining room status, QR check-in occupancy, and upcoming bookings.</p>
          </div>
          <div class="res-subview-bar">
            <div class="pricing-mode-switch" role="group" aria-label="Reservations workspace view">
              <button type="button" class="pricing-mode-btn ${reservationsSubView === 'floor-plan' ? 'active' : ''}" data-res-subview="floor-plan">
                <i class="fa-solid fa-table-cells"></i> Floor Plan Layout
              </button>
              <button type="button" class="pricing-mode-btn ${reservationsSubView === 'list' ? 'active' : ''}" data-res-subview="list">
                <i class="fa-solid fa-list"></i> Reservations (${resList.length})
              </button>
            </div>
            <button type="button" id="refresh-floor-plan-btn" class="btn-outline-sm">
              <i class="fa-solid fa-rotate"></i> Refresh
            </button>
          </div>
        </div>
        <p id="res-floor-status" class="form-status ${reservationsFeedback ? 'success' : ''}" aria-live="polite">${escapeAttr(reservationsFeedback)}</p>
        ${reservationsSubView === 'floor-plan' ? floorPlanHtml : listHtml}
      </div>
    `;
    reservationsFeedback = '';

    bodyEl.querySelectorAll('[data-res-subview]').forEach((btn) => {
      btn.addEventListener('click', () => {
        reservationsSubView = btn.getAttribute('data-res-subview') === 'list' ? 'list' : 'floor-plan';
        renderReservationsManager();
      });
    });

    bodyEl.querySelector('#refresh-floor-plan-btn')?.addEventListener('click', () => {
      loadAndRender();
    });

    bodyEl.querySelectorAll('[data-start-seat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        floorSeatTargetId = btn.getAttribute('data-start-seat') || '';
        renderReservationsManager();
        bodyEl.querySelector('.floor-quick-seat-form input[name="guestName"]')?.focus();
      });
    });

    bodyEl.querySelectorAll('[data-cancel-seat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        floorSeatTargetId = '';
        renderReservationsManager();
      });
    });

    bodyEl.querySelectorAll('[data-seat-form]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const tableLabel = form.getAttribute('data-seat-form');
        const guestName = form.querySelector('input[name="guestName"]')?.value.trim() || 'Walk-In Guest';
        try {
          const res = await apiFetch('/api/owner/tables/check-in', {
            method: 'POST',
            body: JSON.stringify({ tableLabel, guestName }),
          });
          if (res?.session) onTableSessionSyncToFirestore?.(res.session).catch(() => {});
          floorSeatTargetId = '';
          reservationsFeedback = `Seated ${guestName} at ${tableLabel}.`;
          await loadAndRender();
        } catch (err) {
          const statusEl = bodyEl.querySelector('#res-floor-status');
          if (statusEl) {
            statusEl.textContent = err.message;
            statusEl.className = 'form-status error';
          }
        }
      });
    });

    bodyEl.querySelectorAll('[data-release-table]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tableId = btn.getAttribute('data-release-table');
        if (!tableId) return;
        try {
          await apiFetch(`/api/owner/tables/${encodeURIComponent(tableId)}/release`, {
            method: 'POST',
            body: '{}',
          });
          onTableReleaseFromFirestore?.(tableId).catch(() => {});
          reservationsFeedback = `Released ${tableId} back to available.`;
          await loadAndRender();
        } catch (err) {
          const statusEl = bodyEl.querySelector('#res-floor-status');
          if (statusEl) {
            statusEl.textContent = err.message;
            statusEl.className = 'form-status error';
          }
        }
      });
    });

    bodyEl.querySelectorAll('[data-jump-orders]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = 'orders';
        tabBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-owner-tab') === activeTab));
        renderActiveTab();
      });
    });

    bodyEl.querySelectorAll('[data-open-qr-for-table]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const label = btn.getAttribute('data-open-qr-for-table') || 'Table 05';
        qrTablePreset = label;
        qrTableCustom = '';
        activeTab = 'tools';
        tabBtns.forEach((b) => b.classList.toggle('active', b.getAttribute('data-owner-tab') === activeTab));
        renderActiveTab();
      });
    });

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

    bodyEl.querySelectorAll('[data-res-table]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.getAttribute('data-res-table');
        const current = resList.find((r) => r.id === id);
        await apiFetch(`/api/owner/reservations/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: current?.status || 'confirmed',
            tableLabel: sel.value,
          }),
        });
        reservationsFeedback = sel.value
          ? `Assigned reservation ${id} to ${sel.value}.`
          : `Cleared table assignment on ${id}.`;
        await onReservationsMutated?.();
        loadAndRender();
      });
    });
  }

  function renderInventoryManager() {
    const inv = snapshot.inventory || [];
    const alertSummary = buildLowStockNotifications(inv);
    snapshot.inventoryAlertSummary = alertSummary;
    updateInventoryTabBadge(alertSummary);

    const dismissedCount = Math.max(0, alertSummary.totalAlertCount - alertSummary.activeAlertCount);
    const visibleAlerts = showDismissedAlerts ? alertSummary.allAlerts : alertSummary.activeAlerts;

    const evaluatedRows = inv.map((item) => ({
      item,
      evalInfo: evaluateInventoryStock(item),
    }));
    const filteredRows = invFilterMode === 'alerts'
      ? evaluatedRows.filter((entry) => entry.evalInfo.needsReorder)
      : evaluatedRows;

    const alertsBannerHtml = alertSummary.totalAlertCount === 0
      ? `
        <div id="owner-inv-alerts-panel" class="inv-alerts-panel is-healthy" role="status">
          <div class="inv-alerts-head">
            <div>
              <span class="inv-status-label is-healthy">Healthy Stock</span>
              <h4>All ${inv.length} Kitchen Ingredients Above Reorder Thresholds</h4>
            </div>
            <p class="inv-alerts-meta">Automated monitor tracks every order deduction and threshold adjustment.</p>
          </div>
        </div>`
      : `
        <div id="owner-inv-alerts-panel" class="inv-alerts-panel" role="region" aria-label="Automated Low-Stock Notifications">
          <div class="inv-alerts-head">
            <div>
              <span class="inv-status-label ${alertSummary.criticalCount > 0 ? 'is-critical' : 'is-warning'}">
                Automated Reorder Monitor
              </span>
              <h4>
                <span class="tabular-nums">${alertSummary.totalAlertCount}</span> Ingredient${alertSummary.totalAlertCount === 1 ? '' : 's'} Need Reordering
                ${alertSummary.criticalCount > 0 ? `· <span class="inv-critical-count tabular-nums">${alertSummary.criticalCount} Critical</span>` : ''}
              </h4>
              <p class="inv-alerts-meta">
                Estimated restock budget to target safety level: <strong class="tabular-nums">${formatRupees(alertSummary.totalEstimatedRestockCost)}</strong>
              </p>
            </div>
            ${
              dismissedCount > 0
                ? `<button type="button" class="btn-outline-sm" id="inv-toggle-dismissed">
                    ${showDismissedAlerts ? 'Hide Dismissed Alerts' : `Show Dismissed (${dismissedCount})`}
                  </button>`
                : ''
            }
          </div>

          ${
            visibleAlerts.length === 0
              ? `<p class="inv-alerts-muted">All ${dismissedCount} low-stock alert${dismissedCount === 1 ? ' is' : 's are'} currently acknowledged. Alerts automatically re-trigger if stock drops further or thresholds increase.</p>`
              : `<ul class="inv-alert-list">
                  ${visibleAlerts
                    .map(
                      (a) => `
                    <li class="inv-alert-item ${a.status === 'out_of_stock' ? 'is-critical' : 'is-warning'}">
                      <div class="inv-alert-copy">
                        <div class="inv-alert-title-row">
                          <span class="inv-status-label ${a.severity === 'critical' ? 'is-critical' : 'is-warning'}">
                            ${a.status === 'out_of_stock' ? 'Out of Stock' : 'Low Stock'}
                          </span>
                          <strong>${escapeAttr(a.name)}</strong>
                          <small class="tabular-nums">${escapeAttr(a.sku)}</small>
                          ${a.isAcknowledged ? '<small class="inv-ack-note">Acknowledged</small>' : ''}
                        </div>
                        <p class="inv-alert-detail tabular-nums">
                          Current: <strong>${a.stockQty} ${escapeAttr(a.unit)}</strong> · Threshold: <strong>${a.reorderLevel} ${escapeAttr(a.unit)}</strong> · Recommended Restock: <strong>+${a.recommendedReorderQty} ${escapeAttr(a.unit)}</strong> (${formatRupees(a.estimatedRestockCost)})
                        </p>
                      </div>
                      <div class="inv-alert-actions">
                        <button type="button" class="btn-forest btn-sm-inline" data-inv-restock="${escapeAttr(a.id)}">
                          Restock +${a.recommendedReorderQty}
                        </button>
                        ${
                          !a.isAcknowledged
                            ? `<button type="button" class="btn-outline-sm" data-inv-ack="${escapeAttr(a.id)}">Dismiss</button>`
                            : ''
                        }
                      </div>
                    </li>`
                    )
                    .join('')}
                </ul>`
          }
        </div>`;

    bodyEl.innerHTML = `
      ${alertsBannerHtml}
      <p id="inv-action-status" class="form-status ${lastInvFeedback ? 'success' : ''}" aria-live="polite">${escapeAttr(lastInvFeedback)}</p>
      <div class="owner-two-col owner-inv-layout">
        <div class="owner-card">
          <div class="owner-card-head inv-table-head">
            <h4>Kitchen Inventory (${inv.length} SKUs)</h4>
            <div class="inv-filter-group" role="group" aria-label="Filter kitchen inventory">
              <button type="button" class="btn-outline-sm ${invFilterMode === 'all' ? 'active-filter' : ''}" data-inv-filter="all">All (${inv.length})</button>
              <button type="button" class="btn-outline-sm ${invFilterMode === 'alerts' ? 'active-filter' : ''}" data-inv-filter="alerts">Needs Reorder (${alertSummary.totalAlertCount})</button>
            </div>
          </div>
          <div class="owner-table-wrap">
            <table class="owner-table">
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th>Status &amp; Stock</th>
                  <th>Reorder Threshold</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${
                  filteredRows.length === 0
                    ? '<tr><td colspan="4" class="muted-empty">No ingredients match this filter.</td></tr>'
                    : filteredRows
                        .map(({ item: i, evalInfo }) => {
                          const rowClass = evalInfo.status === 'out_of_stock'
                            ? 'row-critical'
                            : evalInfo.needsReorder
                              ? 'row-warn'
                              : '';
                          const statusText = evalInfo.status === 'out_of_stock'
                            ? 'Out of Stock'
                            : evalInfo.needsReorder
                              ? 'Low Stock'
                              : 'Healthy';
                          const statusClass = evalInfo.severity === 'critical'
                            ? 'is-critical'
                            : evalInfo.severity === 'warning'
                              ? 'is-warning'
                              : 'is-healthy';
                          return `
                          <tr class="${rowClass}">
                            <td>
                              <strong>${escapeAttr(i.name)}</strong>
                              <div class="owner-cell-meta tabular-nums">${escapeAttr(i.sku)} · ${formatRupees(i.costPerUnit)}/${escapeAttr(i.unit)}</div>
                            </td>
                            <td>
                              <span class="inv-status-label ${statusClass}">${statusText}</span>
                              <div class="tabular-nums inv-qty-readout"><strong>${i.stockQty}</strong> ${escapeAttr(i.unit)}</div>
                            </td>
                            <td>
                              <div class="inv-threshold-editor">
                                <input type="number" min="0" max="10000" step="1" class="inline-rupee-input" data-inv-threshold="${escapeAttr(i.id)}" value="${i.reorderLevel}" aria-label="Reorder threshold for ${escapeAttr(i.name)}">
                                <button type="button" class="btn-outline-sm" data-inv-save-threshold="${escapeAttr(i.id)}">Set</button>
                              </div>
                            </td>
                            <td class="table-actions inv-row-actions">
                              <button type="button" class="btn-outline-sm" data-inv-delta="${escapeAttr(i.id)}:-5">−5</button>
                              <button type="button" class="btn-gold-sm" data-inv-delta="${escapeAttr(i.id)}:10">+10</button>
                              ${
                                evalInfo.needsReorder
                                  ? `<button type="button" class="btn-forest btn-sm-inline" data-inv-restock="${escapeAttr(i.id)}">Restock</button>`
                                  : ''
                              }
                              <button type="button" class="btn-danger-sm" data-inv-del="${escapeAttr(i.id)}">Delete</button>
                            </td>
                          </tr>`;
                        })
                        .join('')
                }
              </tbody>
            </table>
          </div>
        </div>
        <form id="owner-inv-form" class="owner-card owner-form">
          <h4>Add Inventory Item</h4>
          <label>Ingredient Name <input type="text" id="inv-name" placeholder="e.g. Pistachio Paste" required></label>
          <div class="owner-form-row">
            <label>Unit <input type="text" id="inv-unit" value="kg" required></label>
            <label>Initial Qty <input type="number" id="inv-qty" value="20" min="0" required></label>
          </div>
          <div class="owner-form-row">
            <label>Reorder Threshold <input type="number" id="inv-reorder" value="5" min="0" required></label>
            <label>Cost/Unit (₹) <input type="number" step="1" id="inv-cost" value="250" min="0" required></label>
          </div>
          <button type="submit" class="btn-forest">Add Inventory Stock</button>
        </form>
      </div>
    `;

    lastInvFeedback = '';

    bodyEl.querySelector('#inv-toggle-dismissed')?.addEventListener('click', () => {
      showDismissedAlerts = !showDismissedAlerts;
      renderInventoryManager();
    });

    bodyEl.querySelectorAll('[data-inv-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        invFilterMode = btn.getAttribute('data-inv-filter') === 'alerts' ? 'alerts' : 'all';
        renderInventoryManager();
      });
    });

    bodyEl.querySelectorAll('[data-inv-restock]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-inv-restock');
        try {
          const res = await apiFetch(`/api/owner/inventory/${encodeURIComponent(id)}/restock`, {
            method: 'POST',
            body: '{}',
          });
          if (res?.item) onInventorySyncToFirestore?.(res.item).catch(() => {});
          lastInvFeedback = `Restocked ${res.item?.name || 'ingredient'} by +${res.addedQty} ${res.item?.unit || ''}.`;
          await loadAndRender();
        } catch (err) {
          const st = bodyEl.querySelector('#inv-action-status');
          if (st) {
            st.textContent = err.message;
            st.className = 'form-status error';
          }
        }
      });
    });

    bodyEl.querySelectorAll('[data-inv-ack]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-inv-ack');
        try {
          const res = await apiFetch(`/api/owner/inventory/${encodeURIComponent(id)}/acknowledge`, {
            method: 'POST',
            body: '{}',
          });
          if (res?.item) onInventorySyncToFirestore?.(res.item).catch(() => {});
          lastInvFeedback = `Alert dismissed for ${res.item?.name || 'ingredient'}. Will re-alert if stock drops further.`;
          await loadAndRender();
        } catch (err) {
          const st = bodyEl.querySelector('#inv-action-status');
          if (st) {
            st.textContent = err.message;
            st.className = 'form-status error';
          }
        }
      });
    });

    bodyEl.querySelectorAll('[data-inv-save-threshold]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-inv-save-threshold');
        const input = bodyEl.querySelector(`[data-inv-threshold="${CSS.escape(id)}"]`);
        const nextLevel = Math.max(0, Number(input?.value ?? 0));
        try {
          const res = await apiFetch(`/api/owner/inventory/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({ reorderLevel: nextLevel }),
          });
          if (res?.item) onInventorySyncToFirestore?.(res.item).catch(() => {});
          lastInvFeedback = `Updated reorder threshold for ${res.item?.name || 'ingredient'} to ${nextLevel} ${res.item?.unit || ''}.`;
          await loadAndRender();
        } catch (err) {
          const st = bodyEl.querySelector('#inv-action-status');
          if (st) {
            st.textContent = err.message;
            st.className = 'form-status error';
          }
        }
      });
    });

    bodyEl.querySelectorAll('[data-inv-delta]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const [id, deltaStr] = btn.getAttribute('data-inv-delta').split(':');
        const current = inv.find((item) => item.id === id);
        if (!current) return;
        const nextQty = Math.max(0, Number(current.stockQty) + Number(deltaStr));
        const res = await apiFetch(`/api/owner/inventory/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({ stockQty: nextQty }),
        });
        if (res?.item) onInventorySyncToFirestore?.(res.item).catch(() => {});
        lastInvFeedback = `Updated ${current.name} stock to ${nextQty} ${current.unit}.`;
        await loadAndRender();
      });
    });

    bodyEl.querySelectorAll('[data-inv-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-inv-del');
        await apiFetch(`/api/owner/inventory/${encodeURIComponent(id)}`, { method: 'DELETE' });
        onInventoryDeleteFromFirestore?.(id).catch(() => {});
        lastInvFeedback = 'Removed inventory SKU.';
        await loadAndRender();
      });
    });

    bodyEl.querySelector('#owner-inv-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await apiFetch('/api/owner/inventory', {
        method: 'POST',
        body: JSON.stringify({
          name: bodyEl.querySelector('#inv-name').value,
          unit: bodyEl.querySelector('#inv-unit').value,
          stockQty: Number(bodyEl.querySelector('#inv-qty').value),
          reorderLevel: Number(bodyEl.querySelector('#inv-reorder').value),
          costPerUnit: Number(bodyEl.querySelector('#inv-cost').value),
        }),
      });
      if (res?.item) onInventorySyncToFirestore?.(res.item).catch(() => {});
      lastInvFeedback = `Added ${res.item?.name || 'new ingredient'} to Kitchen Inventory.`;
      await loadAndRender();
    });
  }

  function renderCrmAndReviews() {
    const customers = snapshot.customers || [];
    const reviews = snapshot.reviews || [];
    const loyaltyData = getActiveLoyaltyAnalytics();
    bodyEl.innerHTML = `
      ${renderLoyaltyVizHtml(loyaltyData)}
      <div class="owner-two-col">
        <div class="owner-card">
          <h4>Customer CRM (${customers.length})</h4>
          ${
            customers.length === 0
              ? '<p class="muted-empty">Registered customer profiles appear here.</p>'
              : `<div class="owner-table-wrap"><table class="owner-table">
                  <thead><tr><th>Guest &amp; Tier</th><th>Orders</th><th>Spent</th><th>Earned / Balance</th></tr></thead>
                  <tbody>
                    ${customers
                      .map(
                        (c) => `<tr><td><strong>${escapeAttr(c.displayName)}</strong><br><small>${escapeAttr(c.tier || 'Club Guest')} · ${escapeAttr(c.email)}</small></td><td class="tabular-nums">${c.totalOrders}</td><td class="tabular-nums">${formatRupees(c.totalSpent, { decimals: true })}</td><td class="tabular-nums"><strong>${Number(c.totalLoyaltyEarned ?? c.loyaltyPoints ?? 0)} earned</strong><br><small>${c.loyaltyPoints} avail</small></td></tr>`
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

    mountLoyaltyVisualizations(loyaltyData);

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

  function renderOwnerTools() {
    const activeTableLabel = normalizeTableLabel(qrTableCustom.trim() || qrTablePreset);
    const initialUrl = buildTableMenuUrl({
      origin: qrBaseOrigin,
      tableLabel: activeTableLabel,
      orderType: 'dine_in',
      sectionHash: '#interactive-menu',
    });

    bodyEl.innerHTML = `
      <div class="owner-two-col owner-tools-grid">
        <div class="owner-card owner-form">
          <div class="owner-card-head">
            <div>
              <h4>Table QR Code Generator</h4>
              <p class="qr-card-sub">Generate printable scannable QR codes linked directly to Pier 25&rsquo;s live interactive menu.</p>
            </div>
          </div>

          <div class="owner-form-row">
            <label>Table / Dining Zone Preset
              <select id="qr-table-preset">
                ${DEFAULT_TABLE_PRESETS.map(
                  (preset) => `<option value="${escapeAttr(preset)}" ${qrTablePreset === preset ? 'selected' : ''}>${escapeAttr(preset)}</option>`
                ).join('')}
              </select>
            </label>
            <label>Custom Table Label (optional)
              <input type="text" id="qr-table-custom" maxlength="24" value="${escapeAttr(qrTableCustom)}" placeholder="e.g. Patio 12 or Terrace">
            </label>
          </div>

          <label>Menu Destination Origin
            <div class="qr-origin-row">
              <input type="url" id="qr-base-url" value="${escapeAttr(qrBaseOrigin)}" placeholder="https://your-domain.com">
              <button type="button" id="qr-reset-origin" class="btn-outline-sm">Use Current Site</button>
            </div>
          </label>

          <div class="owner-form-row">
            <label>Table Card Headline
              <input type="text" id="qr-headline" maxlength="64" value="${escapeAttr(qrHeadline)}">
            </label>
            <label>Guest Prompt Copy
              <input type="text" id="qr-subcopy" maxlength="100" value="${escapeAttr(qrSubcopy)}">
            </label>
          </div>

          <div class="qr-url-box">
            <span>Target Live Menu URL</span>
            <code id="qr-generated-url">${escapeAttr(initialUrl)}</code>
          </div>

          <div class="qr-action-bar">
            <button type="button" id="qr-print-btn" class="btn-forest">
              <i class="fa-solid fa-print"></i> Print Table Card
            </button>
            <button type="button" id="qr-download-png-btn" class="btn-gold-sm">
              <i class="fa-solid fa-download"></i> Download PNG
            </button>
            <button type="button" id="qr-download-svg-btn" class="btn-outline-sm">
              <i class="fa-solid fa-file-code"></i> Download SVG
            </button>
            <button type="button" id="qr-copy-url-btn" class="btn-outline-sm">
              <i class="fa-solid fa-copy"></i> Copy Link
            </button>
            <button type="button" id="qr-preview-link-btn" class="btn-outline-sm">
              <i class="fa-solid fa-mobile-screen"></i> Test Table Ordering
            </button>
          </div>
          <p id="qr-tool-status" class="form-status" aria-live="polite"></p>
        </div>

        <div class="owner-card qr-preview-stage">
          <div class="owner-card-head">
            <h4>Printable Standee Preview</h4>
            <span class="qr-print-hint">Works in print &amp; tabletop acrylic sleeves</span>
          </div>
          <div id="qr-printable-card" class="qr-printable-card" aria-label="Printable Pier 25 Table Ordering QR Card">
            <div class="qr-card-brand">
              <span class="qr-brand-name">Pier 25</span>
              <span class="qr-brand-sub">DineFlow AI · Table Service</span>
            </div>
            <div class="qr-table-pill-heading" id="qr-preview-table-title">
              ${escapeAttr(activeTableLabel || 'Live Interactive Menu')}
            </div>
            <h5 id="qr-preview-headline">${escapeAttr(qrHeadline)}</h5>
            <p id="qr-preview-subcopy">${escapeAttr(qrSubcopy)}</p>
            <div id="qr-svg-frame" class="qr-svg-frame" role="img" aria-label="QR Code linking to Pier 25 live interactive menu"></div>
            <div class="qr-card-steps">
              <span>1. Scan Camera</span>
              <span>·</span>
              <span>2. Customise Dishes</span>
              <span>·</span>
              <span>3. Order to Table</span>
            </div>
            <div class="qr-card-footer-url tabular-nums" id="qr-preview-footer-url">${escapeAttr(initialUrl)}</div>
          </div>
        </div>
      </div>
    `;

    const presetEl = bodyEl.querySelector('#qr-table-preset');
    const customEl = bodyEl.querySelector('#qr-table-custom');
    const baseUrlEl = bodyEl.querySelector('#qr-base-url');
    const headlineEl = bodyEl.querySelector('#qr-headline');
    const subcopyEl = bodyEl.querySelector('#qr-subcopy');
    const urlReadoutEl = bodyEl.querySelector('#qr-generated-url');
    const previewTableTitleEl = bodyEl.querySelector('#qr-preview-table-title');
    const previewHeadlineEl = bodyEl.querySelector('#qr-preview-headline');
    const previewSubcopyEl = bodyEl.querySelector('#qr-preview-subcopy');
    const previewFooterUrlEl = bodyEl.querySelector('#qr-preview-footer-url');
    const svgFrameEl = bodyEl.querySelector('#qr-svg-frame');
    const statusEl = bodyEl.querySelector('#qr-tool-status');

    function getCurrentQrUrl() {
      const label = normalizeTableLabel(qrTableCustom.trim() || qrTablePreset);
      return buildTableMenuUrl({
        origin: qrBaseOrigin,
        tableLabel: label,
        orderType: 'dine_in',
        sectionHash: '#interactive-menu',
      });
    }

    async function refreshQrPreview() {
      const label = normalizeTableLabel(qrTableCustom.trim() || qrTablePreset);
      const url = getCurrentQrUrl();
      if (urlReadoutEl) urlReadoutEl.textContent = url;
      if (previewTableTitleEl) previewTableTitleEl.textContent = label || 'Live Interactive Menu';
      if (previewHeadlineEl) previewHeadlineEl.textContent = qrHeadline || 'Scan to Browse Menu & Order';
      if (previewSubcopyEl) previewSubcopyEl.textContent = qrSubcopy || 'Order seamlessly from your table';
      if (previewFooterUrlEl) previewFooterUrlEl.textContent = url;

      const seq = ++qrRenderSeq;
      try {
        const [svgString, pngDataUrl] = await Promise.all([
          QRCode.toString(url, {
            type: 'svg',
            width: 220,
            margin: 2,
            errorCorrectionLevel: 'M',
            color: { dark: '#12261d', light: '#fffdf8' },
          }),
          QRCode.toDataURL(url, {
            width: 720,
            margin: 2,
            errorCorrectionLevel: 'M',
            color: { dark: '#12261d', light: '#fffdf8' },
          }),
        ]);
        if (seq !== qrRenderSeq) return;
        qrLatestSvgMarkup = svgString;
        qrLatestPngDataUrl = pngDataUrl;
        if (svgFrameEl) svgFrameEl.innerHTML = svgString;
      } catch (err) {
        if (seq === qrRenderSeq && statusEl) {
          statusEl.textContent = err?.message || 'Unable to render QR matrix for this URL.';
          statusEl.className = 'form-status error';
        }
      }
    }

    presetEl?.addEventListener('change', (e) => {
      qrTablePreset = e.target.value;
      qrTableCustom = '';
      if (customEl) customEl.value = '';
      refreshQrPreview();
    });

    customEl?.addEventListener('input', (e) => {
      qrTableCustom = e.target.value;
      refreshQrPreview();
    });

    baseUrlEl?.addEventListener('input', (e) => {
      qrBaseOrigin = e.target.value;
      refreshQrPreview();
    });

    bodyEl.querySelector('#qr-reset-origin')?.addEventListener('click', () => {
      qrBaseOrigin = window.location?.origin || 'http://localhost:3000';
      if (baseUrlEl) baseUrlEl.value = qrBaseOrigin;
      refreshQrPreview();
    });

    headlineEl?.addEventListener('input', (e) => {
      qrHeadline = e.target.value;
      refreshQrPreview();
    });

    subcopyEl?.addEventListener('input', (e) => {
      qrSubcopy = e.target.value;
      refreshQrPreview();
    });

    bodyEl.querySelector('#qr-print-btn')?.addEventListener('click', () => {
      document.body.classList.add('printing-qr-card');
      const cleanup = () => {
        document.body.classList.remove('printing-qr-card');
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      window.print();
      window.setTimeout(cleanup, 1200);
    });

    bodyEl.querySelector('#qr-download-png-btn')?.addEventListener('click', () => {
      if (!qrLatestPngDataUrl) return;
      const label = normalizeTableLabel(qrTableCustom.trim() || qrTablePreset) || 'general-menu';
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const link = document.createElement('a');
      link.href = qrLatestPngDataUrl;
      link.download = `pier25-${slug}-qr.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      if (statusEl) {
        statusEl.textContent = `Downloaded PNG QR code for ${label}.`;
        statusEl.className = 'form-status success';
      }
    });

    bodyEl.querySelector('#qr-download-svg-btn')?.addEventListener('click', () => {
      if (!qrLatestSvgMarkup) return;
      const label = normalizeTableLabel(qrTableCustom.trim() || qrTablePreset) || 'general-menu';
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const blob = new Blob([qrLatestSvgMarkup], { type: 'image/svg+xml;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `pier25-${slug}-qr.svg`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      if (statusEl) {
        statusEl.textContent = `Downloaded vector SVG QR code for ${label}.`;
        statusEl.className = 'form-status success';
      }
    });

    bodyEl.querySelector('#qr-copy-url-btn')?.addEventListener('click', async () => {
      const url = getCurrentQrUrl();
      try {
        await navigator.clipboard.writeText(url);
        if (statusEl) {
          statusEl.textContent = 'Copied live menu QR link to clipboard.';
          statusEl.className = 'form-status success';
        }
      } catch {
        if (statusEl) {
          statusEl.textContent = `Link ready: ${url}`;
          statusEl.className = 'form-status info';
        }
      }
    });

    bodyEl.querySelector('#qr-preview-link-btn')?.addEventListener('click', () => {
      const url = getCurrentQrUrl();
      closeModal();
      onOpenTablePreview?.(url);
    });

    refreshQrPreview();
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
