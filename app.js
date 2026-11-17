import {
  STORAGE_KEY,
  createBookingRecord,
  formatTime12h,
  getTodayDateString,
  parseStoredBookings,
  removeBookingById,
  validateBooking,
} from './booking.js';
import {
  clampSlideIndex,
  getMaxSlideIndex,
  getNextSlideIndex,
  getPrevSlideIndex,
  getTrackOffsetPercent,
  getVisibleCardsCount,
} from './slider.js';
import {
  deleteMenuItemFromFirestore,
  signInWithGooglePopup,
  signOutFirebase,
  syncMenuItemToFirestore,
  syncOrderToFirestore,
  syncReservationToFirestore,
  syncReviewToFirestore,
} from './firebase-client.js';
import { createCartController, formatINR, getEffectiveItemPrice } from './cart-checkout.js';
import { createAiConciergeController } from './ai-concierge.js';
import { createOwnerDashboardController } from './owner-dashboard.js';

let currentUser = null;
let menuItems = [];
let siteSettings = {};
let reviewsList = [];
let activeCategory = 'All';
let activeAiMatchedIds = null;

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getPriceMarkup(dish) {
  const effective = getEffectiveItemPrice(dish);
  if (effective === null) {
    return '<span class="price-pending-label">Price Set by Owner</span>';
  }
  if (dish.discountPrice && Number(dish.discountPrice) > 0 && Number(dish.discountPrice) < Number(dish.price)) {
    return `<span class="price-offer tabular-nums">${formatINR(dish.discountPrice)}</span> <span class="price-strike tabular-nums">${formatINR(dish.price)}</span>`;
  }
  return `<span class="price-regular tabular-nums">${formatINR(effective)}</span>`;
}

function getDietaryMarkHtml(dish) {
  const isNonVeg = dish?.dietaryType === 'non-veg';
  const label = isNonVeg ? 'Non-Veg' : 'Veg';
  return `<span class="dietary-mark ${isNonVeg ? 'is-nonveg' : 'is-veg'}" title="${label}" aria-label="${label}"><span></span></span>`;
}

function getHighlightMeta(dish) {
  const flags = [];
  if (dish.isBestseller || dish.isPopular) flags.push('Bestseller');
  if (dish.isNewArrival || dish.isNew) flags.push('New Arrival');
  if (dish.isRecommended) flags.push('Recommended');
  if (dish.stockStatus === 'low_stock') flags.push('Limited Batch');
  if (dish.available === false || dish.stockStatus === 'out_of_stock') flags.push('Unavailable');
  return flags;
}

function isOrderable(dish) {
  return getEffectiveItemPrice(dish) !== null && dish.available !== false && dish.stockStatus !== 'out_of_stock';
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload;
}

// Header Search & Mobile Navigation
const searchicon1 = document.querySelector('#searchicon1');
const search1 = document.querySelector('#searchinput1');
if (searchicon1 && search1) {
  searchicon1.addEventListener('click', () => {
    search1.style.display = 'flex';
    searchicon1.style.display = 'none';
  });
}

const searchicon2 = document.querySelector('#searchicon2');
const search2 = document.querySelector('#searchinput2');
if (searchicon2 && search2) {
  searchicon2.addEventListener('click', () => {
    search2.style.display = 'flex';
    searchicon2.style.display = 'none';
  });
}

const bar = document.querySelector('.fa-bars');
const cross = document.querySelector('#hdcross');
const headerbar = document.querySelector('.headerbar');

function closeMobileNav() {
  if (!headerbar || !cross) return;
  cross.style.display = 'none';
  headerbar.style.right = '-100%';
}

if (bar && cross && headerbar) {
  bar.addEventListener('click', () => {
    setTimeout(() => {
      cross.style.display = 'block';
    }, 180);
    headerbar.style.right = '0%';
  });
  cross.addEventListener('click', closeMobileNav);
}

// Cart, AI Concierge, and Owner Controllers
const cartController = createCartController({
  apiFetch,
  getUser: () => currentUser,
  onUserUpdated: (updated) => {
    currentUser = updated;
    updateAuthHeaderUI();
  },
  onOrderCompleted: (order) => {
    syncOrderToFirestore(order).catch(() => {});
    if (currentUser) loadProfileOrders();
  },
  onCartChanged: (count) => {
    document.querySelectorAll('[data-cart-count]').forEach((el) => {
      el.textContent = String(count);
    });
  },
  getSettings: () => siteSettings,
  getMenuItems: () => menuItems,
});

const aiController = createAiConciergeController({
  apiFetch,
  getMenuItems: () => menuItems,
  onOpenDish: (dishId) => openDishModal(dishId),
  onAddToCart: (dish) => {
    if (cartController.addDish(dish, 1)) {
      cartController.openDrawer();
    } else {
      openDishModal(dish.id);
    }
  },
});

const ownerController = createOwnerDashboardController({
  apiFetch,
  getMenuItems: () => menuItems,
  onMenuMutated: async () => {
    await loadMenuCatalog();
  },
  onMenuSyncToFirestore: async (item) => {
    await syncMenuItemToFirestore(item);
  },
  onMenuDeleteFromFirestore: async (itemId) => {
    await deleteMenuItemFromFirestore(itemId);
  },
  onReservationsMutated: async () => {
    await loadReservations();
  },
});

document.querySelector('#open-cart-btn')?.addEventListener('click', () => cartController.openDrawer());
document.querySelector('#open-cart-mb')?.addEventListener('click', () => {
  closeMobileNav();
  cartController.openDrawer();
});
document.querySelector('#open-ai-btn')?.addEventListener('click', () => aiController.openDrawer('chat'));
document.querySelector('#open-ai-mb')?.addEventListener('click', () => {
  closeMobileNav();
  aiController.openDrawer('chat');
});
document.querySelector('#hero-ai-btn')?.addEventListener('click', () => aiController.openDrawer('chat'));
document.querySelector('#open-visual-search-btn')?.addEventListener('click', () => aiController.openDrawer('visual'));
document.querySelector('#drawer-backdrop')?.addEventListener('click', () => {
  cartController.closeDrawer();
  aiController.closeDrawer();
});

// Dish Detail Modal with Customisation Options & INR Pricing
const dishModal = document.querySelector('#dish-modal');
const dishModalContent = document.querySelector('#dish-modal-content');
document.querySelector('#close-dish-modal')?.addEventListener('click', () => {
  if (dishModal) dishModal.hidden = true;
});

function openDishModal(dishId) {
  const dish = menuItems.find((m) => m.id === dishId);
  if (!dish || !dishModal || !dishModalContent) return;

  const canOrder = isOrderable(dish);
  const effectivePrice = getEffectiveItemPrice(dish);
  const customGroups = Array.isArray(dish.customisationOptions) ? dish.customisationOptions : [];
  const highlights = getHighlightMeta(dish);

  dishModalContent.innerHTML = `
    <div class="dish-detail-grid">
      <img src="${escapeHtml(dish.imageUrl)}" alt="${escapeHtml(dish.name)}">
      <div class="dish-detail-info">
        <p class="eyebrow">
          ${getDietaryMarkHtml(dish)}
          ${escapeHtml(dish.category)}${dish.subcategory ? ` · ${escapeHtml(dish.subcategory)}` : ''} · ${dish.prepMinutes || 10} mins · ${dish.calories || 250} kcal
        </p>
        <h3 id="dish-modal-title">${escapeHtml(dish.name)}</h3>
        <div class="dish-detail-price">${getPriceMarkup(dish)}</div>
        <p>${escapeHtml(dish.description)}</p>
        <p class="menu-card-tags">
          ${[...new Set([...highlights, ...(dish.dietaryTags || [])])].map(escapeHtml).join(' · ') || 'House Favorite'} · ${dish.rating || 4.8}★
        </p>
        <h4>Ingredients</h4>
        <ul class="ingredients-list">
          ${(dish.ingredients || ['Chef Signature Spices']).map((ing) => `<li>${escapeHtml(ing)}</li>`).join('')}
        </ul>
        ${
          customGroups.length > 0
            ? `<div class="customisation-box">
                <h4>Customise Your Order</h4>
                ${customGroups
                  .map(
                    (group, gIdx) => `
                  <div class="customisation-group">
                    <span class="customisation-label">${escapeHtml(group.name)}</span>
                    <div class="customisation-choices">
                      ${(group.choices || [])
                        .map(
                          (choice, cIdx) => `
                        <label class="custom-choice-chip">
                          <input type="radio" name="dish-cust-${gIdx}" value="${escapeHtml(choice)}" data-cust-group="${escapeHtml(group.name)}" ${cIdx === 0 ? 'checked' : ''}>
                          <span>${escapeHtml(choice)}</span>
                        </label>`
                        )
                        .join('')}
                    </div>
                  </div>`
                  )
                  .join('')}
              </div>`
            : ''
        }
        <div class="hero-actions">
          <button type="button" class="btn-forest" id="modal-add-to-cart" ${canOrder ? '' : 'disabled'}>
            ${
              dish.available === false || dish.stockStatus === 'out_of_stock'
                ? 'Currently Unavailable'
                : effectivePrice === null
                  ? 'Price Set by Owner'
                  : `Add to Order · ${formatINR(effectivePrice)}`
            }
          </button>
          <button type="button" class="btn-outline-sm" id="modal-ask-ai">Ask AI Pairing</button>
        </div>
      </div>
    </div>
  `;

  dishModalContent.querySelector('#modal-add-to-cart')?.addEventListener('click', () => {
    const selectedCustomisations = {};
    dishModalContent.querySelectorAll('input[data-cust-group]:checked').forEach((input) => {
      const gName = input.getAttribute('data-cust-group');
      if (gName) selectedCustomisations[gName] = input.value;
    });
    const added = cartController.addDish(
      dish,
      1,
      Object.keys(selectedCustomisations).length > 0 ? selectedCustomisations : null
    );
    if (added) {
      dishModal.hidden = true;
      cartController.openDrawer();
    }
  });

  dishModalContent.querySelector('#modal-ask-ai')?.addEventListener('click', () => {
    dishModal.hidden = true;
    aiController.openDrawer('chat');
  });

  dishModal.hidden = false;
}

// Curated Coffee, Croissants & Bakery Collection Sections (9 Customer Website Sections)
const cafeNavEl = document.querySelector('#cafe-section-nav');
const cafeSectionsEl = document.querySelector('#coffee-croissant-sections');

const CAFE_SECTION_SPECS = [
  {
    id: 'sec-bestselling-coffees',
    title: 'Bestselling Coffees',
    subtitle: 'Signature espresso & cold coffee favorites loved by Pier 25 guests',
    match: (m) => m.category === 'Coffee' && (m.isBestseller || m.isPopular),
  },
  {
    id: 'sec-hot-coffee',
    title: 'Hot Coffee',
    subtitle: 'Single-origin espresso extractions and velvety micro-foam classics',
    match: (m) => (m.category === 'Coffee' || m.category === 'Beverages') && m.showcaseSection === 'Hot Coffee',
  },
  {
    id: 'sec-cold-coffee',
    title: 'Cold Coffee',
    subtitle: '18-hour slow-steeped cold brew, Vietnamese phin brew, and iced pours',
    match: (m) => m.category === 'Coffee' && m.showcaseSection === 'Cold Coffee',
  },
  {
    id: 'sec-speciality-coffee',
    title: 'Speciality Coffee',
    subtitle: 'House-crafted caramel, Madagascar vanilla, Piedmont hazelnut & Spanish lattes',
    match: (m) => m.category === 'Coffee' && m.showcaseSection === 'Speciality Coffee',
  },
  {
    id: 'sec-classic-croissants',
    title: 'Classic Croissants',
    subtitle: '27-layer European cultured butter viennoiserie baked golden daily',
    match: (m) => m.category === 'Croissants' && m.showcaseSection === 'Classic Croissants',
  },
  {
    id: 'sec-chocolate-nut-croissants',
    title: 'Chocolate & Nut Croissants',
    subtitle: '70% Belgian couverture chocolate, roasted almond, pistachio & Nutella folds',
    match: (m) => m.category === 'Croissants' && m.showcaseSection === 'Chocolate & Nut Croissants',
  },
  {
    id: 'sec-fruit-croissants',
    title: 'Fruit Croissants',
    subtitle: 'Fresh Mahabaleshwar strawberry diplomat & wild blueberry compote pastries',
    match: (m) => m.category === 'Croissants' && m.showcaseSection === 'Fruit Croissants',
  },
  {
    id: 'sec-savory-croissants',
    title: 'Savory Croissants',
    subtitle: 'Aged cheddar, roasted garlic butter, cream cheese, chicken & mushroom croissants',
    match: (m) => m.category === 'Croissants' && m.showcaseSection === 'Savory Croissants',
  },
  {
    id: 'sec-bakery-desserts',
    title: 'Bakery & Desserts',
    subtitle: 'Small-batch muffins, cinnamon rolls, fudge brownies, cheesecake, tiramisu & danishes',
    match: (m) => m.category === 'Bakery & Desserts' || m.showcaseSection === 'Bakery & Desserts',
  },
];

function createShowcaseCard(dish) {
  const card = document.createElement('article');
  const unavailable = dish.available === false || dish.stockStatus === 'out_of_stock';
  const canOrder = isOrderable(dish);
  const hasCustom = Array.isArray(dish.customisationOptions) && dish.customisationOptions.length > 0;
  const highlights = getHighlightMeta(dish);

  card.className = `cafe-item-card${unavailable ? ' is-unavailable' : ''}`;
  card.innerHTML = `
    <div class="cafe-card-media" data-open-dish="${escapeHtml(dish.id)}">
      <img src="${escapeHtml(dish.imageUrl)}" alt="${escapeHtml(dish.name)}" loading="lazy">
    </div>
    <div class="cafe-card-body">
      <div class="cafe-card-meta">
        ${getDietaryMarkHtml(dish)}
        <span>${escapeHtml(dish.subcategory || dish.category)}</span>
        <span>· ${dish.prepMinutes || 5}m</span>
        ${highlights.length ? `<span class="cafe-card-highlight">· ${escapeHtml(highlights[0])}</span>` : ''}
      </div>
      <h4 data-open-dish="${escapeHtml(dish.id)}">${escapeHtml(dish.name)}</h4>
      <p class="cafe-card-desc">${escapeHtml(dish.description)}</p>
      <p class="cafe-card-ing">${escapeHtml((dish.ingredients || []).slice(0, 3).join(' · '))}</p>
      <div class="cafe-card-foot">
        <div class="cafe-card-price">${getPriceMarkup(dish)}</div>
        <div class="cafe-card-actions">
          <button type="button" class="btn-outline-sm" data-open-dish="${escapeHtml(dish.id)}">${hasCustom ? 'Customise' : 'Details'}</button>
          ${
            canOrder
              ? `<button type="button" class="btn-gold-sm" data-add-dish="${escapeHtml(dish.id)}">+ Add</button>`
              : ''
          }
        </div>
      </div>
    </div>
  `;

  card.querySelectorAll('[data-open-dish]').forEach((el) => {
    el.addEventListener('click', () => openDishModal(dish.id));
  });

  card.querySelector('[data-add-dish]')?.addEventListener('click', () => {
    if (cartController.addDish(dish, 1)) {
      cartController.openDrawer();
    }
  });

  return card;
}

function renderCafeShowcaseSections() {
  if (!cafeSectionsEl || !cafeNavEl) return;
  cafeNavEl.innerHTML = '';
  cafeSectionsEl.innerHTML = '';

  const populated = CAFE_SECTION_SPECS.map((spec) => ({
    ...spec,
    items: menuItems.filter(spec.match),
  })).filter((sec) => sec.items.length > 0);

  for (const sec of populated) {
    const navLink = document.createElement('a');
    navLink.href = `#${sec.id}`;
    navLink.className = 'cafe-nav-link';
    navLink.textContent = sec.title;
    cafeNavEl.appendChild(navLink);

    const block = document.createElement('section');
    block.className = 'cafe-sub-section';
    block.id = sec.id;
    block.innerHTML = `
      <div class="cafe-sub-head">
        <div>
          <h3>${escapeHtml(sec.title)}</h3>
          <p>${escapeHtml(sec.subtitle)}</p>
        </div>
        <span class="cafe-count tabular-nums">${sec.items.length} ${sec.items.length === 1 ? 'item' : 'items'}</span>
      </div>
      <div class="cafe-cards-grid"></div>
    `;

    const grid = block.querySelector('.cafe-cards-grid');
    for (const item of sec.items) {
      grid.appendChild(createShowcaseCard(item));
    }
    cafeSectionsEl.appendChild(block);
  }
}

// Interactive Menu Catalog & Filters (Unified Food Items)
const categoryTabsEl = document.querySelector('#menu-category-tabs');
const subcategoryFilterEl = document.querySelector('#menu-subcategory-filter');
const vegFilterEl = document.querySelector('#menu-veg-filter');
const highlightFilterEl = document.querySelector('#menu-highlight-filter');
const menuGridEl = document.querySelector('#menu-catalog-grid');
const searchInputEl = document.querySelector('#menu-search-input');
const dietaryFilterEl = document.querySelector('#menu-dietary-filter');
const sortSelectEl = document.querySelector('#menu-sort-select');
const aiSearchBannerEl = document.querySelector('#ai-search-banner');

function renderCategoryTabs() {
  if (!categoryTabsEl) return;
  const preferredOrder = ['All', 'Coffee', 'Croissants', 'Bakery & Desserts'];
  const allCats = [...new Set(menuItems.map((m) => m.category))];
  const orderedCats = [
    ...preferredOrder.filter((c) => c === 'All' || allCats.includes(c)),
    ...allCats.filter((c) => !preferredOrder.includes(c)),
  ];

  categoryTabsEl.innerHTML = '';
  for (const cat of orderedCats) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cat === activeCategory ? 'cat-tab-btn active' : 'cat-tab-btn';
    btn.textContent = cat;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(cat === activeCategory));
    btn.addEventListener('click', () => {
      activeCategory = cat;
      renderCategoryTabs();
      populateSubcategoryFilter();
      renderMenuCatalog();
    });
    categoryTabsEl.appendChild(btn);
  }
}

function populateSubcategoryFilter() {
  if (!subcategoryFilterEl) return;
  const currentVal = subcategoryFilterEl.value;
  const pool = activeCategory === 'All' ? menuItems : menuItems.filter((m) => m.category === activeCategory);
  const subs = [...new Set(pool.map((m) => m.subcategory).filter(Boolean))];
  subcategoryFilterEl.innerHTML = '<option value="all">All Subcategories</option>';
  for (const sub of subs) {
    const opt = document.createElement('option');
    opt.value = sub;
    opt.textContent = sub;
    subcategoryFilterEl.appendChild(opt);
  }
  subcategoryFilterEl.value = subs.includes(currentVal) ? currentVal : 'all';
}

function renderMenuCatalog() {
  if (!menuGridEl) return;
  const q = (searchInputEl?.value || '').trim().toLowerCase();
  const subcat = subcategoryFilterEl?.value || 'all';
  const vegType = vegFilterEl?.value || 'all';
  const highlight = highlightFilterEl?.value || 'all';
  const dietary = dietaryFilterEl?.value || 'all';
  const sortBy = sortSelectEl?.value || 'featured';

  let list = [...menuItems];
  if (activeAiMatchedIds) {
    const set = new Set(activeAiMatchedIds);
    list = list.filter((m) => set.has(m.id));
  }
  if (activeCategory !== 'All') {
    list = list.filter((m) => m.category === activeCategory);
  }
  if (subcat !== 'all') {
    list = list.filter((m) => m.subcategory === subcat);
  }
  if (vegType !== 'all') {
    list = list.filter((m) => (m.dietaryType === 'non-veg' ? 'non-veg' : 'veg') === vegType);
  }
  if (highlight === 'bestseller') {
    list = list.filter((m) => m.isBestseller || m.isPopular);
  } else if (highlight === 'new') {
    list = list.filter((m) => m.isNewArrival || m.isNew);
  } else if (highlight === 'recommended') {
    list = list.filter((m) => m.isRecommended);
  }
  if (dietary !== 'all') {
    list = list.filter((m) => (m.dietaryTags || []).includes(dietary));
  }
  if (q && !activeAiMatchedIds) {
    list = list.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q) ||
        (m.subcategory || '').toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        (m.ingredients || []).some((ing) => ing.toLowerCase().includes(q))
    );
  }

  if (sortBy === 'price-asc') {
    list.sort((a, b) => (getEffectiveItemPrice(a) ?? Infinity) - (getEffectiveItemPrice(b) ?? Infinity));
  } else if (sortBy === 'price-desc') {
    list.sort((a, b) => (getEffectiveItemPrice(b) ?? -1) - (getEffectiveItemPrice(a) ?? -1));
  } else if (sortBy === 'prep-asc') {
    list.sort((a, b) => (a.prepMinutes || 15) - (b.prepMinutes || 15));
  }

  menuGridEl.innerHTML = '';
  if (list.length === 0) {
    menuGridEl.innerHTML = `<div class="empty-state"><p>No dishes match these filters. Try clearing your search or asking the AI Food Concierge.</p></div>`;
    return;
  }

  for (const dish of list) {
    const canOrder = isOrderable(dish);
    const unavailable = dish.available === false || dish.stockStatus === 'out_of_stock';
    const highlights = getHighlightMeta(dish);
    const card = document.createElement('article');
    card.className = `menu-card${unavailable ? ' is-unavailable' : ''}`;
    card.innerHTML = `
      <div class="menu-card-media" data-open-dish="${escapeHtml(dish.id)}">
        <img src="${escapeHtml(dish.imageUrl)}" alt="${escapeHtml(dish.name)}" loading="lazy">
      </div>
      <div class="menu-card-body">
        <div class="menu-card-meta">
          ${getDietaryMarkHtml(dish)}
          <span>${escapeHtml(dish.subcategory || dish.category)}</span>
          <span>· ${dish.prepMinutes || 10}m</span>
          <span>· ${dish.rating || 4.8}★</span>
        </div>
        <h3 data-open-dish="${escapeHtml(dish.id)}">${escapeHtml(dish.name)}</h3>
        <p class="menu-card-desc">${escapeHtml(dish.description)}</p>
        <p class="menu-card-tags">${[...new Set([...highlights, ...(dish.dietaryTags || [])])].map(escapeHtml).join(' · ') || 'House Special'}</p>
        <div class="menu-card-footer">
          <div class="menu-card-price">${getPriceMarkup(dish)}</div>
          <div class="menu-card-actions">
            <button type="button" class="btn-outline-sm" data-open-dish="${escapeHtml(dish.id)}">Details</button>
            ${
              canOrder
                ? `<button type="button" class="btn-gold-sm" data-add-dish="${escapeHtml(dish.id)}">+ Add</button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
    card.querySelectorAll('[data-open-dish]').forEach((el) => {
      el.addEventListener('click', () => openDishModal(dish.id));
    });
    card.querySelector('[data-add-dish]')?.addEventListener('click', () => {
      if (cartController.addDish(dish, 1)) {
        cartController.openDrawer();
      }
    });
    menuGridEl.appendChild(card);
  }
}

function syncStaticShowcasePrices() {
  const byId = new Map(menuItems.map((m) => [m.id, m]));
  document.querySelectorAll('[data-dish-id]').forEach((el) => {
    const dish = byId.get(el.getAttribute('data-dish-id'));
    if (!dish) return;
    const priceEl = el.querySelector('.item-price, .fav-price, .new-food-price');
    if (priceEl) priceEl.innerHTML = getPriceMarkup(dish);
  });
}

async function loadMenuCatalog() {
  try {
    const res = await apiFetch('/api/menu');
    menuItems = res.items || [];
    siteSettings = res.settings || {};
    renderCafeShowcaseSections();
    renderCategoryTabs();
    populateSubcategoryFilter();
    renderMenuCatalog();
    syncStaticShowcasePrices();
    populateReviewDishes();
  } catch {
    menuItems = [];
  }
}

searchInputEl?.addEventListener('input', () => {
  activeAiMatchedIds = null;
  if (aiSearchBannerEl) aiSearchBannerEl.hidden = true;
  renderMenuCatalog();
});

subcategoryFilterEl?.addEventListener('change', renderMenuCatalog);
vegFilterEl?.addEventListener('change', renderMenuCatalog);
highlightFilterEl?.addEventListener('change', renderMenuCatalog);
dietaryFilterEl?.addEventListener('change', renderMenuCatalog);
sortSelectEl?.addEventListener('change', renderMenuCatalog);

document.querySelector('#ai-search-btn')?.addEventListener('click', async () => {
  const query = searchInputEl?.value.trim();
  if (!query || !aiSearchBannerEl) return;
  aiSearchBannerEl.hidden = false;
  aiSearchBannerEl.textContent = 'Searching menu semantically with Gemini AI...';
  try {
    const res = await apiFetch('/api/ai/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
    activeAiMatchedIds = res.matchedIds || [];
    aiSearchBannerEl.innerHTML = `
      <span><strong>AI Search:</strong> ${escapeHtml(res.summary)}</span>
      <button type="button" class="btn-outline-sm" id="clear-ai-search">Clear AI Filter</button>
    `;
    aiSearchBannerEl.querySelector('#clear-ai-search')?.addEventListener('click', () => {
      activeAiMatchedIds = null;
      aiSearchBannerEl.hidden = true;
      renderMenuCatalog();
    });
    renderMenuCatalog();
  } catch (err) {
    aiSearchBannerEl.textContent = err.message;
  }
});

// Wire header quick search bars to interactive menu search
function jumpToMenuSearch(val) {
  if (!searchInputEl) return;
  searchInputEl.value = val;
  activeAiMatchedIds = null;
  renderMenuCatalog();
  document.querySelector('#interactive-menu')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
document.querySelector('#desktop-header-search-btn')?.addEventListener('click', () => {
  jumpToMenuSearch(document.querySelector('#desktop-header-search')?.value || '');
});
document.querySelector('#mobile-header-search-btn')?.addEventListener('click', () => {
  closeMobileNav();
  jumpToMenuSearch(document.querySelector('#mobile-header-search')?.value || '');
});

// Wire Popular Cards, Spotlight Cards & Slider Add buttons
document.querySelectorAll('.main-slide3 .fav-food .item').forEach((card) => {
  const dishId = card.getAttribute('data-dish-id');
  card.addEventListener('click', () => dishId && openDishModal(dishId));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (dishId) openDishModal(dishId);
    }
  });
});

document.querySelectorAll('.food-items .item [data-quick-dish]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-quick-dish');
    if (id && menuItems.some((m) => m.id === id)) openDishModal(id);
    else document.querySelector('#interactive-menu')?.scrollIntoView({ behavior: 'smooth' });
  });
});

document.querySelectorAll('.slider-add-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = btn.getAttribute('data-add-dish');
    const dish = menuItems.find((m) => m.id === id);
    if (dish && cartController.addDish(dish, 1)) {
      cartController.openDrawer();
    } else if (dish) {
      openDishModal(dish.id);
    }
  });
});

// Customer Reviews & Loyalty
const reviewsContainer = document.querySelector('#reviews-list');
const reviewDishSelect = document.querySelector('#review-dish');
const reviewForm = document.querySelector('#review-form');
const reviewStatus = document.querySelector('#review-status');

function populateReviewDishes() {
  if (!reviewDishSelect) return;
  const current = reviewDishSelect.value;
  reviewDishSelect.innerHTML = '<option value="">Overall Dining Experience</option>';
  for (const m of menuItems) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    reviewDishSelect.appendChild(opt);
  }
  reviewDishSelect.value = current;
}

function renderReviews() {
  if (!reviewsContainer) return;
  reviewsContainer.innerHTML = '';
  for (const rev of reviewsList.slice(0, 6)) {
    const card = document.createElement('div');
    card.className = 'review-card';
    card.innerHTML = `
      <div class="review-card-head">
        <strong>${escapeHtml(rev.authorName)}</strong>
        <span class="review-stars tabular-nums">${'★'.repeat(rev.rating)} (${rev.rating}/5)</span>
      </div>
      <p>${escapeHtml(rev.comment)}</p>
    `;
    reviewsContainer.appendChild(card);
  }
}

async function loadReviews() {
  try {
    const res = await apiFetch('/api/reviews');
    reviewsList = res.reviews || [];
    renderReviews();
  } catch {
    reviewsList = [];
  }
}

reviewForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser) {
    openAuthModal();
    if (reviewStatus) reviewStatus.textContent = 'Please sign in first to post a verified review.';
    return;
  }
  try {
    const res = await apiFetch('/api/reviews', {
      method: 'POST',
      body: JSON.stringify({
        rating: Number(document.querySelector('#review-rating')?.value || 5),
        dishId: reviewDishSelect?.value || '',
        comment: document.querySelector('#review-comment')?.value || '',
      }),
    });
    if (res.user) {
      currentUser = res.user;
      updateAuthHeaderUI();
    }
    syncReviewToFirestore(res.review).catch(() => {});
    document.querySelector('#review-comment').value = '';
    if (reviewStatus) reviewStatus.textContent = 'Thank you! +15 loyalty points added.';
    await loadReviews();
  } catch (err) {
    if (reviewStatus) reviewStatus.textContent = err.message;
  }
});

// Table Reservations (#book-table preserved + backend synced)
const bookingSection = document.querySelector('#book-table');
const bookingForm = document.querySelector('#booking-form');
const nameInput = document.querySelector('#booking-name');
const dateInput = document.querySelector('#booking-date');
const timeInput = document.querySelector('#booking-time');
const partySizeInput = document.querySelector('#booking-party-size');
const confirmationBox = document.querySelector('#booking-confirmation');
const bookingListWrapper = document.querySelector('#booking-list-wrapper');
const bookingList = document.querySelector('#booking-list');

const fieldMap = {
  name: { input: nameInput, errorEl: document.querySelector('#error-name') },
  date: { input: dateInput, errorEl: document.querySelector('#error-date') },
  time: { input: timeInput, errorEl: document.querySelector('#error-time') },
  partySize: { input: partySizeInput, errorEl: document.querySelector('#error-partySize') },
};

let bookings = [];

function loadBookingsFromStorage() {
  try {
    return parseStoredBookings(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

function saveBookingsToStorage(nextBookings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextBookings));
  } catch {
    // Ignore storage errors
  }
}

async function loadReservations() {
  const local = loadBookingsFromStorage();
  if (!currentUser) {
    bookings = local;
    renderBookingsList();
    return;
  }
  try {
    const res = await apiFetch('/api/reservations/mine');
    const serverRes = (res.reservations || []).filter((r) => r.status !== 'cancelled');
    const mergedMap = new Map(serverRes.map((r) => [r.id, r]));
    for (const b of local) {
      if (!mergedMap.has(b.id)) mergedMap.set(b.id, b);
    }
    bookings = [...mergedMap.values()];
  } catch {
    bookings = local;
  }
  renderBookingsList();
}

function setFieldErrors(errors, { shakeInvalid = false } = {}) {
  for (const [key, { input, errorEl }] of Object.entries(fieldMap)) {
    const message = errors[key] || '';
    if (errorEl) errorEl.textContent = message;
    if (input) {
      input.classList.remove('input-shake');
      if (message) {
        input.setAttribute('aria-invalid', 'true');
        if (shakeInvalid) {
          void input.offsetWidth;
          input.classList.add('input-shake');
        }
      } else {
        input.removeAttribute('aria-invalid');
      }
    }
  }
}

function renderBookingsList() {
  if (!bookingList || !bookingListWrapper) return;
  bookingList.innerHTML = '';

  if (bookings.length === 0) {
    bookingListWrapper.hidden = true;
    return;
  }

  bookingListWrapper.hidden = false;
  for (const booking of bookings) {
    const item = document.createElement('li');
    item.className = 'booking-item';
    const summary = document.createElement('span');
    summary.textContent = `${booking.name} — ${booking.date} at ${formatTime12h(booking.time)} (${booking.partySize} ${booking.partySize === 1 ? 'guest' : 'guests'}) [${booking.id}]`;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'booking-item-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.setAttribute('aria-label', `Cancel reservation for ${booking.name} on ${booking.date}`);
    cancelBtn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/reservations/${encodeURIComponent(booking.id)}/cancel`, { method: 'PATCH' });
      } catch {
        // Local-only fallback if server record is already removed
      }
      bookings = removeBookingById(bookings, booking.id);
      saveBookingsToStorage(bookings);
      renderBookingsList();
    });

    item.append(summary, cancelBtn);
    bookingList.appendChild(item);
  }
}

function showConfirmation(booking) {
  if (!confirmationBox) return;
  confirmationBox.hidden = false;
  confirmationBox.innerHTML = '';

  const title = document.createElement('strong');
  title.textContent = `Table Reserved! (${booking.id}) `;
  const details = document.createElement('span');
  details.textContent = `We look forward to welcoming ${booking.name} for a party of ${booking.partySize} on ${booking.date} at ${formatTime12h(booking.time)}.`;
  confirmationBox.append(title, details);
}

if (dateInput) {
  dateInput.min = getTodayDateString();
}

for (const [, { input, errorEl }] of Object.entries(fieldMap)) {
  if (!input) continue;
  input.addEventListener('input', () => {
    if (errorEl) errorEl.textContent = '';
    input.removeAttribute('aria-invalid');
    input.classList.remove('input-shake');
  });
  input.addEventListener('animationend', () => {
    input.classList.remove('input-shake');
  });
}

bookingForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = validateBooking({
    name: nameInput ? nameInput.value : '',
    date: dateInput ? dateInput.value : '',
    time: timeInput ? timeInput.value : '',
    partySize: partySizeInput ? partySizeInput.value : '',
  });

  if (!result.valid) {
    setFieldErrors(result.errors, { shakeInvalid: true });
    if (confirmationBox) confirmationBox.hidden = true;
    const firstInvalidKey = Object.keys(result.errors)[0];
    if (firstInvalidKey && fieldMap[firstInvalidKey]?.input) {
      fieldMap[firstInvalidKey].input.focus();
    }
    return;
  }

  setFieldErrors({});
  let record;
  try {
    const res = await apiFetch('/api/reservations', {
      method: 'POST',
      body: JSON.stringify(result.normalized),
    });
    record = res.reservation;
    syncReservationToFirestore(record).catch(() => {});
  } catch {
    record = createBookingRecord(result.normalized);
  }

  bookings = [record, ...bookings];
  saveBookingsToStorage(bookings);
  renderBookingsList();
  showConfirmation(record);
  bookingForm.reset();
});

document.querySelectorAll('a[href="#book-table"], #hero-book-btn').forEach((link) => {
  link.addEventListener('click', (event) => {
    if (!bookingSection) return;
    event.preventDefault();
    closeMobileNav();
    bookingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (nameInput) setTimeout(() => nameInput.focus({ preventScroll: true }), 250);
  });
});

document.querySelectorAll('.headerbar .nav a:not([href="#book-table"])').forEach((link) => {
  link.addEventListener('click', closeMobileNav);
});

// Newsletter Form
document.querySelector('#newsletter-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const emailEl = document.querySelector('#newsletter-email');
  const statusEl = document.querySelector('#newsletter-status');
  try {
    await apiFetch('/api/newsletter', {
      method: 'POST',
      body: JSON.stringify({ email: emailEl?.value || '' }),
    });
    if (statusEl) statusEl.textContent = 'Subscribed to Pier 25 seasonal dining updates!';
    if (emailEl) emailEl.value = '';
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message;
  }
});

// Auth, Customer Profile & Owner Studio Entry
const authModal = document.querySelector('#auth-modal');
const authGuestView = document.querySelector('#auth-guest-view');
const authProfileView = document.querySelector('#auth-profile-view');
const authForm = document.querySelector('#auth-form');
const authNameWrap = document.querySelector('#auth-name-wrap');
const authSubmitBtn = document.querySelector('#auth-submit-btn');
const authStatusEl = document.querySelector('#auth-status');
const headerUserLabel = document.querySelector('#header-user-label');
const navOwnerWrap = document.querySelector('#nav-owner-wrap');
const profileOwnerBtn = document.querySelector('#profile-open-owner-btn');

let authMode = 'login';

function updateAuthHeaderUI() {
  const isOwner = currentUser?.role === 'owner';
  if (headerUserLabel) {
    headerUserLabel.textContent = currentUser ? currentUser.displayName.split(' ')[0] : 'Sign In';
  }
  if (navOwnerWrap) navOwnerWrap.hidden = !isOwner;
  if (profileOwnerBtn) profileOwnerBtn.hidden = !isOwner;
}

function openAuthModal() {
  if (!authModal) return;
  authModal.hidden = false;
  if (currentUser) {
    authGuestView.hidden = true;
    authProfileView.hidden = false;
    document.querySelector('#profile-display-name').textContent = currentUser.displayName;
    document.querySelector('#profile-email-role').textContent = `${currentUser.email} · ${currentUser.role === 'owner' ? 'Restaurant Owner' : 'Guest Member'}`;
    document.querySelector('#profile-loyalty-pts').textContent = `${currentUser.loyaltyPoints || 0} pts`;
    document.querySelector('#prof-name').value = currentUser.displayName || '';
    document.querySelector('#prof-phone').value = currentUser.phone || '';
    document.querySelector('#prof-dietary').value = currentUser.dietaryPreferences || '';
    document.querySelector('#prof-address').value = currentUser.address || '';
    loadProfileOrders();
  } else {
    authGuestView.hidden = false;
    authProfileView.hidden = true;
  }
}

async function loadProfileOrders() {
  const listEl = document.querySelector('#profile-orders-list');
  if (!listEl || !currentUser) return;
  try {
    const res = await apiFetch('/api/orders/mine');
    const orders = res.orders || [];
    if (orders.length === 0) {
      listEl.innerHTML = '<p class="muted-empty">No past orders yet. Start an order from the menu!</p>';
      return;
    }
    listEl.innerHTML = '';
    for (const o of orders) {
      const row = document.createElement('div');
      row.className = 'profile-order-row';
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(o.id)}</strong> · ${escapeHtml(o.status.replace(/_/g, ' '))}
          <div class="tracking-meta">${o.itemCount} items · ${formatINR(o.total)}</div>
        </div>
        <button type="button" class="btn-outline-sm">Track</button>
      `;
      row.querySelector('button')?.addEventListener('click', () => {
        authModal.hidden = true;
        cartController.trackOrder(o);
      });
      listEl.appendChild(row);
    }
  } catch {
    listEl.innerHTML = '';
  }
}

document.querySelector('#user-lap')?.addEventListener('click', openAuthModal);
document.querySelector('#user-mb')?.addEventListener('click', () => {
  closeMobileNav();
  openAuthModal();
});
document.querySelector('#close-auth-modal')?.addEventListener('click', () => {
  if (authModal) authModal.hidden = true;
});

document.querySelectorAll('[data-auth-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    authMode = btn.getAttribute('data-auth-mode');
    document.querySelectorAll('[data-auth-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    if (authNameWrap) authNameWrap.hidden = authMode !== 'register';
    if (authSubmitBtn) authSubmitBtn.textContent = authMode === 'register' ? 'Create Account' : 'Sign In';
    if (authStatusEl) authStatusEl.textContent = '';
  });
});

authForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (authStatusEl) {
    authStatusEl.textContent = authMode === 'register' ? 'Creating account...' : 'Signing in...';
    authStatusEl.className = 'form-status info';
  }
  try {
    const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const res = await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        displayName: document.querySelector('#auth-name')?.value || '',
        email: document.querySelector('#auth-email')?.value || '',
        password: document.querySelector('#auth-password')?.value || '',
      }),
    });
    currentUser = res.user;
    updateAuthHeaderUI();
    await loadReservations();
    openAuthModal();
  } catch (err) {
    if (authStatusEl) {
      authStatusEl.textContent = err.message;
      authStatusEl.className = 'form-status error';
    }
  }
});

document.querySelector('#google-signin-btn')?.addEventListener('click', async () => {
  if (authStatusEl) {
    authStatusEl.textContent = 'Connecting with Google...';
    authStatusEl.className = 'form-status info';
  }
  try {
    const { idToken } = await signInWithGooglePopup();
    const res = await apiFetch('/api/auth/firebase', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    });
    currentUser = res.user;
    updateAuthHeaderUI();
    await loadReservations();
    openAuthModal();
  } catch (err) {
    if (authStatusEl) {
      authStatusEl.textContent = err.message;
      authStatusEl.className = 'form-status error';
    }
  }
});

document.querySelector('#profile-update-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.querySelector('#profile-save-status');
  try {
    const res = await apiFetch('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({
        displayName: document.querySelector('#prof-name').value,
        phone: document.querySelector('#prof-phone').value,
        dietaryPreferences: document.querySelector('#prof-dietary').value,
        address: document.querySelector('#prof-address').value,
      }),
    });
    currentUser = res.user;
    updateAuthHeaderUI();
    if (status) status.textContent = 'Saved!';
  } catch (err) {
    if (status) status.textContent = err.message;
  }
});

document.querySelector('#profile-logout-btn')?.addEventListener('click', async () => {
  await apiFetch('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  await signOutFirebase();
  currentUser = null;
  updateAuthHeaderUI();
  await loadReservations();
  openAuthModal();
});

function handleOpenOwnerStudio() {
  if (currentUser?.role === 'owner') {
    if (authModal) authModal.hidden = true;
    ownerController.openModal('overview');
  } else {
    openAuthModal();
    if (authStatusEl) {
      authStatusEl.textContent = 'Sign in with the owner email (krishnaladva25@gmail.com) to open Owner Studio.';
      authStatusEl.className = 'form-status info';
    }
  }
}

document.querySelector('#open-owner-nav-btn')?.addEventListener('click', handleOpenOwnerStudio);
document.querySelector('#profile-open-owner-btn')?.addEventListener('click', handleOpenOwnerStudio);
document.querySelector('#footer-owner-link')?.addEventListener('click', handleOpenOwnerStudio);

// New Food Items Slider (Preserved Behavior)
const newFoodSection = document.querySelector('#new-food-items');
const newFoodTrack = document.querySelector('#new-food-track');
const newFoodPrevBtn = document.querySelector('#new-food-prev');
const newFoodNextBtn = document.querySelector('#new-food-next');
const newFoodToggleBtn = document.querySelector('#new-food-toggle');
const newFoodDots = document.querySelector('#new-food-dots');

if (newFoodSection && newFoodTrack) {
  const slides = newFoodTrack.querySelectorAll('.new-food-slide');
  const totalSlides = slides.length;
  let currentSlideIndex = 0;
  let isPaused = false;
  let isHoveredOrFocused = false;
  let autoSlideTimer = null;

  function renderDots(maxIndex) {
    if (!newFoodDots) return;
    newFoodDots.innerHTML = '';
    for (let i = 0; i <= maxIndex; i += 1) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = i === currentSlideIndex ? 'slider-dot active' : 'slider-dot';
      dot.setAttribute('role', 'tab');
      dot.setAttribute('aria-selected', i === currentSlideIndex ? 'true' : 'false');
      dot.setAttribute('aria-label', `Go to slide ${i + 1}`);
      dot.addEventListener('click', () => goToSlide(i));
      newFoodDots.appendChild(dot);
    }
  }

  function updateSliderPosition() {
    const visibleCount = getVisibleCardsCount(window.innerWidth);
    const maxIndex = getMaxSlideIndex(totalSlides, visibleCount);
    currentSlideIndex = clampSlideIndex(currentSlideIndex, maxIndex);
    newFoodTrack.style.setProperty('--visible-cards', String(visibleCount));
    const offsetPercent = getTrackOffsetPercent(currentSlideIndex, visibleCount);
    newFoodTrack.style.transform = `translateX(-${offsetPercent}%)`;
    renderDots(maxIndex);
  }

  function goToSlide(index) {
    const visibleCount = getVisibleCardsCount(window.innerWidth);
    const maxIndex = getMaxSlideIndex(totalSlides, visibleCount);
    currentSlideIndex = clampSlideIndex(index, maxIndex);
    updateSliderPosition();
  }

  function stepNext() {
    const visibleCount = getVisibleCardsCount(window.innerWidth);
    const maxIndex = getMaxSlideIndex(totalSlides, visibleCount);
    currentSlideIndex = getNextSlideIndex(currentSlideIndex, maxIndex);
    updateSliderPosition();
  }

  function stepPrev() {
    const visibleCount = getVisibleCardsCount(window.innerWidth);
    const maxIndex = getMaxSlideIndex(totalSlides, visibleCount);
    currentSlideIndex = getPrevSlideIndex(currentSlideIndex, maxIndex);
    updateSliderPosition();
  }

  function stopAutoSlide() {
    if (autoSlideTimer !== null) {
      window.clearInterval(autoSlideTimer);
      autoSlideTimer = null;
    }
  }

  function startAutoSlide() {
    stopAutoSlide();
    if (isPaused || isHoveredOrFocused) return;
    autoSlideTimer = window.setInterval(stepNext, 3500);
  }

  newFoodNextBtn?.addEventListener('click', () => {
    stepNext();
    startAutoSlide();
  });

  newFoodPrevBtn?.addEventListener('click', () => {
    stepPrev();
    startAutoSlide();
  });

  newFoodToggleBtn?.addEventListener('click', () => {
    isPaused = !isPaused;
    newFoodToggleBtn.setAttribute('aria-pressed', String(isPaused));
    newFoodToggleBtn.setAttribute('aria-label', isPaused ? 'Resume auto slide' : 'Pause auto slide');
    const icon = newFoodToggleBtn.querySelector('i');
    if (icon) icon.className = isPaused ? 'fa-solid fa-play' : 'fa-solid fa-pause';
    if (isPaused) stopAutoSlide();
    else startAutoSlide();
  });

  newFoodSection.addEventListener('mouseenter', () => {
    isHoveredOrFocused = true;
    stopAutoSlide();
  });

  newFoodSection.addEventListener('mouseleave', () => {
    isHoveredOrFocused = false;
    startAutoSlide();
  });

  window.addEventListener('resize', updateSliderPosition);
  updateSliderPosition();
  startAutoSlide();
}

// Boot Application State
async function bootstrap() {
  try {
    const authRes = await apiFetch('/api/auth/me');
    currentUser = authRes.user || null;
  } catch {
    currentUser = null;
  }
  updateAuthHeaderUI();
  await Promise.all([loadMenuCatalog(), loadReviews(), loadReservations()]);
}

bootstrap();
