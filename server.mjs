import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  RestaurantStore,
  calculateCartTotals,
  computeAnalyticsSnapshot,
  signSessionToken,
  verifySessionToken,
} from './backend-store.mjs';
import { buildLowStockNotifications, evaluateInventoryStock } from './inventory-alerts.js';
import {
  analyzeReviewSentiment,
  askBusinessAssistant,
  chatWithConcierge,
  forecastDemand,
  generateMenuDescription,
  generatePromoContent,
  getPersonalizedRecommendations,
  recognizeFoodImage,
  semanticFoodSearch,
} from './ai-service.mjs';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

const COOKIE_NAME = 'krazzy_session';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const UPLOADS_DIR = resolve(process.cwd(), 'uploads');

let firebaseApiKey = '';
try {
  const rawConfig = await readFile(new URL('./firebase-applet-config.json', import.meta.url), 'utf8');
  firebaseApiKey = JSON.parse(rawConfig).apiKey || '';
} catch {
  firebaseApiKey = '';
}

const store = await new RestaurantStore().init();

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

function parseCookies(cookieHeader = '') {
  const out = {};
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function buildSessionCookie(user) {
  const token = signSessionToken(
    {
      uid: user.uid,
      role: user.role,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    },
    store.getSessionSecret()
  );
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function getAuthenticatedUser(request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const payload = verifySessionToken(token, store.getSessionSecret());
  if (!payload?.uid) return null;
  const user = store.findUserById(payload.uid);
  return user ? store.sanitizeUser(user) : null;
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error('Request payload too large (max 8 MB).');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('Malformed JSON request body.');
    err.statusCode = 400;
    throw err;
  }
}

async function verifyFirebaseIdToken(idToken) {
  if (!firebaseApiKey || !idToken) {
    throw new Error('Firebase authentication is not configured.');
  }
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );
  if (!res.ok) {
    throw new Error('Unable to verify Firebase session token.');
  }
  const json = await res.json();
  const account = json?.users?.[0];
  if (!account?.localId || !account?.email) {
    throw new Error('Firebase account lookup returned no user.');
  }
  return {
    uid: account.localId,
    email: account.email,
    displayName: account.displayName || account.email.split('@')[0],
    emailVerified: Boolean(account.emailVerified),
  };
}

function requireAuth(user) {
  if (!user) {
    const err = new Error('Authentication required. Please sign in.');
    err.statusCode = 401;
    throw err;
  }
  return user;
}

function requireOwner(user) {
  requireAuth(user);
  if (user.role !== 'owner') {
    const err = new Error('Owner privileges required.');
    err.statusCode = 403;
    throw err;
  }
  return user;
}

async function handleApiRequest(request, response, pathname) {
  const method = request.method;
  const user = getAuthenticatedUser(request);

  try {
    // Public catalog & settings
    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(response, 200, { ok: true, geminiConfigured: Boolean(process.env.GEMINI_API_KEY) });
    }

    if (method === 'GET' && pathname === '/api/menu') {
      return sendJson(response, 200, {
        items: store.getMenuWithRatings(),
        settings: store.data.settings,
      });
    }

    if (method === 'GET' && pathname === '/api/reviews') {
      return sendJson(response, 200, { reviews: store.data.reviews });
    }

    if (method === 'GET' && pathname === '/api/crm/elite-guests') {
      const reqUrl = new URL(request.url || '/api/crm/elite-guests', 'http://localhost');
      const limitParam = reqUrl.searchParams.get('limit');
      return sendJson(
        response,
        200,
        store.getEliteGuestsLeaderboard({ limit: limitParam ? Number(limitParam) : 6 })
      );
    }

    if (method === 'POST' && pathname === '/api/newsletter') {
      const body = await readJsonBody(request);
      const res = await store.subscribeNewsletter(body.email);
      return sendJson(response, 201, res);
    }

    // Auth routes
    if (method === 'GET' && pathname === '/api/auth/me') {
      return sendJson(response, 200, { user });
    }

    if (method === 'POST' && pathname === '/api/auth/register') {
      const body = await readJsonBody(request);
      const created = await store.registerUser(body);
      return sendJson(
        response,
        201,
        { user: created },
        { 'Set-Cookie': buildSessionCookie(created) }
      );
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(request);
      const loggedIn = await store.loginUser(body);
      return sendJson(
        response,
        200,
        { user: loggedIn },
        { 'Set-Cookie': buildSessionCookie(loggedIn) }
      );
    }

    if (method === 'POST' && pathname === '/api/auth/firebase') {
      const body = await readJsonBody(request);
      const verified = await verifyFirebaseIdToken(body.idToken);
      const synced = await store.upsertFirebaseUser(verified);
      return sendJson(
        response,
        200,
        { user: synced },
        { 'Set-Cookie': buildSessionCookie(synced) }
      );
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      return sendJson(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    }

    if (method === 'PUT' && pathname === '/api/profile') {
      requireAuth(user);
      const body = await readJsonBody(request);
      const updated = await store.updateProfile(user.uid, body);
      return sendJson(response, 200, { user: updated });
    }

    // Customer Cart Quote & Orders
    if (method === 'POST' && pathname === '/api/orders/quote') {
      const body = await readJsonBody(request);
      const totals = calculateCartTotals(body.items, store.data.menuItems, {
        orderType: body.orderType || 'delivery',
        promoCode: body.promoCode || '',
        redeemPoints: body.redeemPoints || 0,
        availablePoints: user ? user.loyaltyPoints : 0,
        settings: store.data.settings,
      });
      return sendJson(response, 200, { totals });
    }

    if (method === 'POST' && pathname === '/api/orders/checkout') {
      const body = await readJsonBody(request);
      const result = await store.createOrder({
        user,
        items: body.items,
        orderType: body.orderType || 'delivery',
        tableNumber: body.tableNumber || '',
        deliveryAddress: body.deliveryAddress,
        customerName: body.customerName,
        customerPhone: body.customerPhone,
        notes: body.notes,
        promoCode: body.promoCode,
        redeemPoints: body.redeemPoints,
        payment: body.payment,
      });
      return sendJson(response, 201, result);
    }

    if (method === 'GET' && pathname === '/api/orders/mine') {
      requireAuth(user);
      const orders = store.data.orders.filter((o) => o.userId === user.uid);
      return sendJson(response, 200, { orders });
    }

    if (method === 'GET' && pathname.startsWith('/api/orders/')) {
      const orderId = decodeURIComponent(pathname.slice('/api/orders/'.length));
      const order = store.data.orders.find((o) => o.id === orderId);
      if (!order) return sendJson(response, 404, { error: 'Order not found.' });
      if (order.userId !== 'guest' && (!user || (user.uid !== order.userId && user.role !== 'owner'))) {
        return sendJson(response, 403, { error: 'Access denied to this order.' });
      }
      return sendJson(response, 200, { order });
    }

    if (method === 'PATCH' && pathname.startsWith('/api/orders/') && pathname.endsWith('/cancel')) {
      requireAuth(user);
      const orderId = decodeURIComponent(pathname.slice('/api/orders/'.length, -'/cancel'.length));
      const order = await store.updateOrderStatus(orderId, 'cancelled', user);
      return sendJson(response, 200, { order });
    }

    // Table Reservations
    if (method === 'GET' && pathname === '/api/reservations/mine') {
      if (!user) return sendJson(response, 200, { reservations: [] });
      const reservations = store.data.reservations.filter((r) => r.userId === user.uid);
      return sendJson(response, 200, { reservations });
    }

    if (method === 'POST' && pathname === '/api/reservations') {
      const body = await readJsonBody(request);
      const reservation = await store.createReservation({
        user,
        name: body.name,
        date: body.date,
        time: body.time,
        partySize: body.partySize,
        notes: body.notes,
      });
      return sendJson(response, 201, { reservation });
    }

    if (method === 'PATCH' && pathname.startsWith('/api/reservations/') && pathname.endsWith('/cancel')) {
      const resId = decodeURIComponent(pathname.slice('/api/reservations/'.length, -'/cancel'.length));
      const reservation = await store.updateReservationStatus(resId, 'cancelled', user);
      return sendJson(response, 200, { reservation });
    }

    // QR Table Check-In (Visual Search Scanner & Table URLs)
    if (method === 'POST' && pathname === '/api/tables/check-in') {
      const body = await readJsonBody(request);
      const res = await store.checkInTable({
        tableLabel: body.tableLabel,
        user,
        guestName: body.guestName || user?.displayName || 'Walk-In QR Guest',
        partySize: body.partySize,
        source: body.source === 'qr_link' ? 'qr_link' : 'qr_scanner',
      });
      return sendJson(response, 200, {
        session: res.session,
        floorPlanSummary: res.floorPlan.summary,
      });
    }

    // Reviews
    if (method === 'POST' && pathname === '/api/reviews') {
      requireAuth(user);
      const body = await readJsonBody(request);
      const review = await store.addReview({
        user,
        authorName: body.authorName || user.displayName,
        rating: body.rating,
        comment: body.comment,
        dishId: body.dishId,
      });
      const updatedUser = store.sanitizeUser(store.findUserById(user.uid));
      return sendJson(response, 201, { review, user: updatedUser });
    }

    // Customer AI Features
    if (method === 'POST' && pathname === '/api/ai/concierge') {
      const body = await readJsonBody(request);
      if (!body.message || typeof body.message !== 'string') {
        return sendJson(response, 400, { error: 'Please enter a message for the AI Food Concierge.' });
      }
      const result = await chatWithConcierge({
        message: body.message.slice(0, 500),
        history: Array.isArray(body.history) ? body.history : [],
        menuItems: store.data.menuItems,
        userPreferences: user?.dietaryPreferences || '',
      });
      return sendJson(response, 200, result);
    }

    if (method === 'POST' && pathname === '/api/ai/recommend') {
      const body = await readJsonBody(request);
      const pastOrders = user ? store.data.orders.filter((o) => o.userId === user.uid) : [];
      const recentDishNames = [...new Set(pastOrders.flatMap((o) => (o.items || []).map((i) => i.name)))].slice(0, 8);
      const result = await getPersonalizedRecommendations({
        preferences: body.preferences || user?.dietaryPreferences || '',
        dietaryTags: Array.isArray(body.dietaryTags) ? body.dietaryTags : [],
        budgetMax: body.budgetMax,
        recentDishNames,
        menuItems: store.data.menuItems,
      });
      return sendJson(response, 200, result);
    }

    if (method === 'POST' && pathname === '/api/ai/search') {
      const body = await readJsonBody(request);
      if (!body.query || typeof body.query !== 'string') {
        return sendJson(response, 400, { error: 'Search query is required.' });
      }
      const result = await semanticFoodSearch({
        query: body.query.slice(0, 240),
        menuItems: store.data.menuItems,
      });
      return sendJson(response, 200, result);
    }

    if (method === 'POST' && pathname === '/api/ai/visual-search') {
      const body = await readJsonBody(request);
      const rawData = String(body.imageBase64 || '');
      const match = rawData.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      const mimeType = match ? match[1] : body.mimeType || 'image/jpeg';
      const base64Data = match ? match[2] : rawData;
      if (!base64Data || base64Data.length < 32) {
        return sendJson(response, 400, { error: 'Please provide a valid food image.' });
      }
      const result = await recognizeFoodImage({
        base64Data,
        mimeType,
        menuItems: store.data.menuItems,
      });
      return sendJson(response, 200, result);
    }

    // Protected Owner Dashboard Routes
    if (pathname.startsWith('/api/owner/') || [
      '/api/ai/menu-description',
      '/api/ai/sentiment',
      '/api/ai/promo',
      '/api/ai/business-assistant',
      '/api/ai/forecast',
    ].includes(pathname)) {
      requireOwner(user);
    }

    if (method === 'GET' && pathname === '/api/owner/overview') {
      return sendJson(response, 200, {
        analytics: computeAnalyticsSnapshot(store.data),
        orders: store.data.orders,
        reservations: store.data.reservations,
        floorPlan: store.getFloorPlanState(),
        inventory: store.data.inventory,
        inventoryAlertSummary: buildLowStockNotifications(store.data.inventory),
        customers: store.getCustomersCRM(),
        loyaltyAnalytics: store.getLoyaltyAnalytics(),
        reviews: store.data.reviews,
        staff: store.data.staff,
        settings: store.data.settings,
      });
    }

    if (method === 'GET' && pathname === '/api/owner/loyalty-analytics') {
      const reqUrl = new URL(request.url || '/api/owner/loyalty-analytics', 'http://localhost');
      const range = ['30d', '90d', 'all'].includes(reqUrl.searchParams.get('range'))
        ? reqUrl.searchParams.get('range')
        : 'all';
      const segmentBy = ['tier', 'neighborhood', 'preference'].includes(reqUrl.searchParams.get('segmentBy'))
        ? reqUrl.searchParams.get('segmentBy')
        : 'tier';
      return sendJson(response, 200, store.getLoyaltyAnalytics({ range, segmentBy }));
    }

    if (method === 'GET' && pathname === '/api/owner/floor-plan') {
      return sendJson(response, 200, store.getFloorPlanState());
    }

    if (method === 'POST' && pathname === '/api/owner/tables/check-in') {
      const body = await readJsonBody(request);
      const res = await store.checkInTable({
        tableLabel: body.tableLabel,
        guestName: body.guestName || 'Walk-In Guest',
        partySize: body.partySize,
        source: 'owner_manual',
      });
      return sendJson(response, 200, res);
    }

    if (method === 'POST' && pathname.startsWith('/api/owner/tables/') && pathname.endsWith('/release')) {
      const tableId = decodeURIComponent(pathname.slice('/api/owner/tables/'.length, -'/release'.length));
      const res = await store.releaseTable(tableId);
      return sendJson(response, 200, res);
    }

    if (method === 'POST' && pathname === '/api/owner/upload-image') {
      const body = await readJsonBody(request);
      const rawData = String(body.imageBase64 || '');
      const match = rawData.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
      if (!match) {
        return sendJson(response, 400, { error: 'Upload must be a PNG, JPG, or WEBP image.' });
      }
      const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > 5 * 1024 * 1024) {
        return sendJson(response, 400, { error: 'Image must be smaller than 5 MB.' });
      }
      await mkdir(UPLOADS_DIR, { recursive: true });
      const filename = `dish-${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`;
      await writeFile(resolve(UPLOADS_DIR, filename), buffer);
      return sendJson(response, 201, { imageUrl: `uploads/${filename}` });
    }

    if (method === 'POST' && pathname === '/api/owner/menu') {
      const body = await readJsonBody(request);
      const item = await store.upsertMenuItem(body);
      return sendJson(response, 201, { item });
    }

    if (method === 'PATCH' && pathname.startsWith('/api/owner/menu/') && pathname.endsWith('/daily-special')) {
      const itemId = decodeURIComponent(pathname.slice('/api/owner/menu/'.length, -'/daily-special'.length));
      const body = await readJsonBody(request);
      const item = await store.setDailySpecial(itemId, {
        enabled: Boolean(body.enabled),
        dailySpecialPrice: body.dailySpecialPrice,
        durationHours: body.durationHours || 24,
      });
      return sendJson(response, 200, { item });
    }

    if (method === 'PUT' && pathname.startsWith('/api/owner/menu/')) {
      const itemId = decodeURIComponent(pathname.slice('/api/owner/menu/'.length));
      const body = await readJsonBody(request);
      const item = await store.upsertMenuItem(body, itemId);
      return sendJson(response, 200, { item });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/owner/menu/')) {
      const itemId = decodeURIComponent(pathname.slice('/api/owner/menu/'.length));
      const res = await store.deleteMenuItem(itemId);
      return sendJson(response, 200, res);
    }

    if (method === 'PATCH' && pathname.startsWith('/api/owner/orders/')) {
      const orderId = decodeURIComponent(pathname.slice('/api/owner/orders/'.length));
      const body = await readJsonBody(request);
      const order = await store.updateOrderStatus(orderId, body.status, user);
      return sendJson(response, 200, { order });
    }

    if (method === 'PATCH' && pathname.startsWith('/api/owner/reservations/')) {
      const resId = decodeURIComponent(pathname.slice('/api/owner/reservations/'.length));
      const body = await readJsonBody(request);
      const reservation = await store.updateReservationStatus(resId, body.status, user, {
        tableLabel: body.tableLabel,
      });
      return sendJson(response, 200, { reservation, floorPlan: store.getFloorPlanState() });
    }

    if (method === 'GET' && pathname === '/api/owner/inventory/alerts') {
      return sendJson(response, 200, buildLowStockNotifications(store.data.inventory));
    }

    if (method === 'POST' && pathname === '/api/owner/inventory') {
      const body = await readJsonBody(request);
      const item = await store.upsertInventoryItem(body);
      return sendJson(response, 201, {
        item,
        evaluation: evaluateInventoryStock(item),
        alertSummary: buildLowStockNotifications(store.data.inventory),
      });
    }

    if (method === 'POST' && pathname.startsWith('/api/owner/inventory/') && pathname.endsWith('/restock')) {
      const invId = decodeURIComponent(pathname.slice('/api/owner/inventory/'.length, -'/restock'.length));
      const body = await readJsonBody(request);
      const result = await store.restockInventoryItem(invId, body?.quantity);
      return sendJson(response, 200, result);
    }

    if (method === 'POST' && pathname.startsWith('/api/owner/inventory/') && pathname.endsWith('/acknowledge')) {
      const invId = decodeURIComponent(pathname.slice('/api/owner/inventory/'.length, -'/acknowledge'.length));
      const result = await store.acknowledgeInventoryAlert(invId);
      return sendJson(response, 200, result);
    }

    if (method === 'PUT' && pathname.startsWith('/api/owner/inventory/')) {
      const invId = decodeURIComponent(pathname.slice('/api/owner/inventory/'.length));
      const body = await readJsonBody(request);
      const item = await store.upsertInventoryItem(body, invId);
      return sendJson(response, 200, {
        item,
        evaluation: evaluateInventoryStock(item),
        alertSummary: buildLowStockNotifications(store.data.inventory),
      });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/owner/inventory/')) {
      const invId = decodeURIComponent(pathname.slice('/api/owner/inventory/'.length));
      const result = await store.deleteInventoryItem(invId);
      return sendJson(response, 200, result);
    }

    if (method === 'DELETE' && pathname.startsWith('/api/owner/reviews/')) {
      const reviewId = decodeURIComponent(pathname.slice('/api/owner/reviews/'.length));
      const res = await store.deleteReview(reviewId, user);
      return sendJson(response, 200, res);
    }

    if (method === 'POST' && pathname === '/api/owner/staff') {
      const body = await readJsonBody(request);
      const member = await store.upsertStaffMember(body);
      return sendJson(response, 201, { member });
    }

    if (method === 'PUT' && pathname.startsWith('/api/owner/staff/')) {
      const staffId = decodeURIComponent(pathname.slice('/api/owner/staff/'.length));
      const body = await readJsonBody(request);
      const member = await store.upsertStaffMember(body, staffId);
      return sendJson(response, 200, { member });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/owner/staff/')) {
      const staffId = decodeURIComponent(pathname.slice('/api/owner/staff/'.length));
      const res = await store.deleteStaffMember(staffId);
      return sendJson(response, 200, res);
    }

    if (method === 'PUT' && pathname === '/api/owner/settings') {
      const body = await readJsonBody(request);
      const settings = await store.updateSettings(body);
      return sendJson(response, 200, { settings });
    }

    // Owner AI Routes
    if (method === 'POST' && pathname === '/api/ai/menu-description') {
      const body = await readJsonBody(request);
      const result = await generateMenuDescription(body);
      return sendJson(response, 200, result);
    }

    if (method === 'POST' && pathname === '/api/ai/sentiment') {
      const result = await analyzeReviewSentiment({ reviews: store.data.reviews });
      return sendJson(response, 200, result);
    }

    if (method === 'POST' && pathname === '/api/ai/promo') {
      const body = await readJsonBody(request);
      const result = await generatePromoContent(body);
      return sendJson(response, 200, result);
    }

    if (method === 'POST' && pathname === '/api/ai/business-assistant') {
      const body = await readJsonBody(request);
      if (!body.question) return sendJson(response, 400, { error: 'Question is required.' });
      const result = await askBusinessAssistant({
        question: String(body.question).slice(0, 500),
        analyticsSnapshot: {
          ...computeAnalyticsSnapshot(store.data),
          menuItems: store.data.menuItems.map((m) => ({ name: m.name, category: m.category, price: m.price, available: m.available })),
        },
      });
      return sendJson(response, 200, result);
    }

    if (method === 'POST' && pathname === '/api/ai/forecast') {
      const result = await forecastDemand({
        analyticsSnapshot: {
          ...computeAnalyticsSnapshot(store.data),
          inventory: store.data.inventory,
          recentReservations: store.data.reservations.slice(0, 15),
        },
      });
      return sendJson(response, 200, result);
    }

    return sendJson(response, 404, { error: 'API endpoint not found.' });
  } catch (error) {
    const statusCode = error?.statusCode || error?.status || 400;
    return sendJson(response, statusCode, {
      error: error?.message || 'Request failed.',
      errors: error?.errors || undefined,
    });
  }
}

const port = Number(process.env.PORT || 3000);
createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent((request.url || '/').split('?')[0]);
  } catch {
    return response.writeHead(400).end('Bad request');
  }

  if (pathname.startsWith('/api/')) {
    return handleApiRequest(request, response, pathname);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return response.writeHead(405, { Allow: 'GET, HEAD' }).end();
  }

  // Uploaded dish images under /uploads/<filename>
  if (pathname.startsWith('/uploads/')) {
    const fileName = pathname.slice('/uploads/'.length);
    const type = types[extname(fileName).toLowerCase()];
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(fileName) || !type) {
      return response.writeHead(404).end('Not found');
    }
    try {
      const file = await readFile(resolve(UPLOADS_DIR, fileName));
      response.writeHead(200, { 'Content-Type': type });
      return response.end(request.method === 'HEAD' ? undefined : file);
    } catch {
      return response.writeHead(404).end('Not found');
    }
  }

  // Optimized AVIF / WebP / PNG / JPEG visual assets under /src/assets/optimized/<filename>
  if (pathname.startsWith('/src/assets/optimized/')) {
    const fileName = pathname.slice('/src/assets/optimized/'.length);
    const type = types[extname(fileName).toLowerCase()];
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(fileName) || !type) {
      return response.writeHead(404).end('Not found');
    }
    try {
      const file = await readFile(resolve(process.cwd(), 'src', 'assets', 'optimized', fileName));
      response.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=604800',
      });
      return response.end(request.method === 'HEAD' ? undefined : file);
    } catch {
      return response.writeHead(404).end('Not found');
    }
  }

  // Generated culinary assets under /src/assets/images/<filename>
  if (pathname.startsWith('/src/assets/images/')) {
    const fileName = pathname.slice('/src/assets/images/'.length);
    const type = types[extname(fileName).toLowerCase()];
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(fileName) || !type) {
      return response.writeHead(404).end('Not found');
    }
    try {
      const file = await readFile(resolve(process.cwd(), 'src', 'assets', 'images', fileName));
      response.writeHead(200, { 'Content-Type': type });
      return response.end(request.method === 'HEAD' ? undefined : file);
    } catch {
      return response.writeHead(404).end('Not found');
    }
  }

  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const type = types[extname(name).toLowerCase()];
  if (!/^[a-z0-9][a-z0-9 ._()-]*$/i.test(name) || !type) {
    return response.writeHead(404).end('Not found');
  }
  try {
    const file = await readFile(new URL(encodeURIComponent(name), import.meta.url));
    response.writeHead(200, { 'Content-Type': type });
    response.end(request.method === 'HEAD' ? undefined : file);
  } catch (error) {
    const missing = error.code === 'ENOENT' || error.code === 'EISDIR';
    if (!missing) console.error(error.message);
    response.writeHead(missing ? 404 : 500).end(missing ? 'Not found' : 'Server error');
  }
}).listen(port, '0.0.0.0', () => console.log('Pier 25 DineFlow AI server is listening on port', port));
