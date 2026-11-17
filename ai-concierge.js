import { formatINR, getEffectiveItemPrice } from './cart-checkout.js';

function getDishPriceLabel(dish) {
  const eff = getEffectiveItemPrice(dish);
  if (eff === null) return 'Price Set by Owner';
  return formatINR(eff);
}

export function createAiConciergeController({
  apiFetch,
  getMenuItems,
  onOpenDish,
  onAddToCart,
}) {
  const drawer = document.querySelector('#ai-drawer');
  const backdrop = document.querySelector('#drawer-backdrop');
  const closeBtn = document.querySelector('#close-ai-btn');
  const tabBtns = document.querySelectorAll('[data-ai-tab]');
  const panels = document.querySelectorAll('[data-ai-panel]');

  const chatMessagesEl = document.querySelector('#ai-chat-messages');
  const chatForm = document.querySelector('#ai-chat-form');
  const chatInput = document.querySelector('#ai-chat-input');
  const chatQuickBtns = document.querySelectorAll('[data-ai-prompt]');

  const recommendForm = document.querySelector('#ai-recommend-form');
  const recommendResultsEl = document.querySelector('#ai-recommend-results');

  const visualForm = document.querySelector('#ai-visual-form');
  const visualFileInput = document.querySelector('#ai-visual-file');
  const visualPreviewEl = document.querySelector('#ai-visual-preview');
  const visualResultsEl = document.querySelector('#ai-visual-results');
  const visualSampleBtns = document.querySelectorAll('[data-visual-sample]');

  let chatHistory = [];
  let selectedImageBase64 = '';

  function openDrawer(tabName = 'chat') {
    if (!drawer) return;
    drawer.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    if (backdrop) backdrop.hidden = false;
    switchTab(tabName);
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.hidden = true;
    drawer.setAttribute('aria-hidden', 'true');
    if (backdrop && document.querySelector('#cart-drawer')?.hidden !== false) {
      backdrop.hidden = true;
    }
  }

  function switchTab(tabName) {
    tabBtns.forEach((btn) => {
      const active = btn.getAttribute('data-ai-tab') === tabName;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    panels.forEach((panel) => {
      panel.hidden = panel.getAttribute('data-ai-panel') !== tabName;
    });
  }

  function renderDishChips(container, dishIds) {
    if (!dishIds?.length) return;
    const menuMap = new Map((getMenuItems() || []).map((m) => [m.id, m]));
    const wrap = document.createElement('div');
    wrap.className = 'ai-dish-chips';

    for (const id of dishIds) {
      const dish = menuMap.get(id);
      if (!dish) continue;
      const canOrder = getEffectiveItemPrice(dish) !== null && dish.available !== false && dish.stockStatus !== 'out_of_stock';
      const card = document.createElement('div');
      card.className = 'ai-mini-dish';
      card.innerHTML = `
        <img src="${dish.imageUrl}" alt="${dish.name}">
        <div>
          <strong>${dish.name}</strong>
          <span class="tabular-nums">${getDishPriceLabel(dish)} · ${dish.subcategory || dish.category}</span>
        </div>
      `;
      const actions = document.createElement('div');
      actions.className = 'ai-mini-actions';

      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'btn-outline-sm';
      viewBtn.textContent = 'Details';
      viewBtn.addEventListener('click', () => onOpenDish(dish.id));

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn-gold-sm';
      addBtn.textContent = canOrder ? '+ Add' : 'Details';
      if (canOrder) {
        addBtn.addEventListener('click', () => onAddToCart(dish));
      } else {
        addBtn.addEventListener('click', () => onOpenDish(dish.id));
      }

      actions.append(viewBtn, addBtn);
      card.appendChild(actions);
      wrap.appendChild(card);
    }
    container.appendChild(wrap);
  }

  function appendChatMessage(role, text, dishIds = []) {
    if (!chatMessagesEl) return;
    const bubble = document.createElement('div');
    bubble.className = `ai-msg ai-msg-${role}`;
    const p = document.createElement('p');
    p.textContent = text;
    bubble.appendChild(p);
    if (dishIds.length) {
      renderDishChips(bubble, dishIds);
    }
    chatMessagesEl.appendChild(bubble);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  async function sendChatMessage(message) {
    const clean = message.trim();
    if (!clean) return;
    appendChatMessage('user', clean);
    chatHistory.push({ role: 'user', text: clean });
    if (chatInput) chatInput.value = '';

    const loadingEl = document.createElement('div');
    loadingEl.className = 'ai-msg ai-msg-assistant ai-loading';
    loadingEl.textContent = 'Chef Concierge is pairing dishes for you...';
    chatMessagesEl?.appendChild(loadingEl);

    try {
      const res = await apiFetch('/api/ai/concierge', {
        method: 'POST',
        body: JSON.stringify({ message: clean, history: chatHistory }),
      });
      loadingEl.remove();
      appendChatMessage('assistant', res.reply, res.recommendedIds || []);
      chatHistory.push({ role: 'assistant', text: res.reply });
    } catch (err) {
      loadingEl.remove();
      appendChatMessage('error', err.message);
    }
  }

  chatForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChatMessage(chatInput?.value || '');
  });

  chatQuickBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      sendChatMessage(btn.getAttribute('data-ai-prompt') || '');
    });
  });

  recommendForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!recommendResultsEl) return;
    recommendResultsEl.innerHTML = '<p class="ai-loading-text">Curating personalized recommendations...</p>';

    const preferences = document.querySelector('#ai-rec-preferences')?.value || '';
    const budgetMax = document.querySelector('#ai-rec-budget')?.value || '';
    const checkedTags = Array.from(document.querySelectorAll('input[name="ai-rec-tag"]:checked')).map((el) => el.value);

    try {
      const res = await apiFetch('/api/ai/recommend', {
        method: 'POST',
        body: JSON.stringify({
          preferences,
          dietaryTags: checkedTags,
          budgetMax: budgetMax ? Number(budgetMax) : undefined,
        }),
      });
      const menuMap = new Map((getMenuItems() || []).map((m) => [m.id, m]));
      recommendResultsEl.innerHTML = `<h4 class="ai-rec-headline">${res.headline}</h4>`;

      for (const rec of res.recommendations || []) {
        const dish = menuMap.get(rec.id);
        if (!dish) continue;
        const canOrder = getEffectiveItemPrice(dish) !== null && dish.available !== false && dish.stockStatus !== 'out_of_stock';
        const card = document.createElement('div');
        card.className = 'ai-rec-card';
        card.innerHTML = `
          <img src="${dish.imageUrl}" alt="${dish.name}">
          <div class="ai-rec-body">
            <div class="ai-rec-title">
              <strong>${dish.name}</strong>
              <span class="tabular-nums">${getDishPriceLabel(dish)}</span>
            </div>
            <p>${rec.reason}</p>
            ${rec.pairingTip ? `<p class="ai-pairing-tip">Pairing: ${rec.pairingTip}</p>` : ''}
            <div class="ai-mini-actions">
              <button type="button" class="btn-outline-sm" data-open="${dish.id}">View Dish</button>
              ${canOrder ? `<button type="button" class="btn-gold-sm" data-add="${dish.id}">+ Add to Cart</button>` : ''}
            </div>
          </div>
        `;
        card.querySelector('[data-open]')?.addEventListener('click', () => onOpenDish(dish.id));
        card.querySelector('[data-add]')?.addEventListener('click', () => onAddToCart(dish));
        recommendResultsEl.appendChild(card);
      }
    } catch (err) {
      recommendResultsEl.innerHTML = `<p class="form-status error">${err.message}</p>`;
    }
  });

  function setVisualPreview(dataUrl) {
    selectedImageBase64 = dataUrl;
    if (visualPreviewEl) {
      visualPreviewEl.innerHTML = `<img src="${dataUrl}" alt="Selected dish for visual search">`;
      visualPreviewEl.hidden = false;
    }
  }

  visualFileInput?.addEventListener('change', () => {
    const file = visualFileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setVisualPreview(reader.result);
    };
    reader.readAsDataURL(file);
  });

  visualSampleBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const src = btn.getAttribute('data-visual-sample');
      if (!src) return;
      try {
        const resp = await fetch(src);
        const blob = await resp.blob();
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') setVisualPreview(reader.result);
        };
        reader.readAsDataURL(blob);
      } catch {
        if (visualResultsEl) {
          visualResultsEl.innerHTML = '<p class="form-status error">Unable to load sample image.</p>';
        }
      }
    });
  });

  visualForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!visualResultsEl) return;
    if (!selectedImageBase64) {
      visualResultsEl.innerHTML = '<p class="form-status error">Upload a food photo or pick a sample dish first.</p>';
      return;
    }
    visualResultsEl.innerHTML = '<p class="ai-loading-text">Analyzing dish ingredients & flavor profile...</p>';
    try {
      const res = await apiFetch('/api/ai/visual-search', {
        method: 'POST',
        body: JSON.stringify({ imageBase64: selectedImageBase64 }),
      });
      visualResultsEl.innerHTML = `
        <div class="ai-vision-card">
          <h4>Detected: ${res.detectedDish}</h4>
          <p><strong>Flavor Profile:</strong> ${res.flavorProfile}</p>
          <p><strong>Visible Ingredients:</strong> ${(res.estimatedIngredients || []).join(', ')}</p>
          <p>${res.matchExplanation}</p>
        </div>
      `;
      renderDishChips(visualResultsEl, res.matchedIds || []);
    } catch (err) {
      visualResultsEl.innerHTML = `<p class="form-status error">${err.message}</p>`;
    }
  });

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-ai-tab')));
  });

  closeBtn?.addEventListener('click', closeDrawer);

  return {
    openDrawer,
    closeDrawer,
  };
}
