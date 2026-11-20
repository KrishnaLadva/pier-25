import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeDailySpecialSavingsPct,
  createDailySpecialWindow,
  formatDailySpecialRemaining,
  isDailySpecialActive,
} from './daily-specials.js';
import {
  DEFAULT_TABLE_PRESETS,
  FLOOR_PLAN_TABLES,
  buildTableMenuUrl,
  normalizeTableLabel,
  parseScannedQrPayload,
  parseTableQueryFromSearch,
  tableLabelToId,
} from './qr-tools.js';
import { RestaurantStore, calculateCartTotals } from './backend-store.mjs';

test('daily-specials helpers compute 24-hour window, active checks, countdown label, and savings percentage', () => {
  const nowMs = Date.parse('2026-11-18T10:00:00.000Z');
  const win = createDailySpecialWindow({
    enabled: true,
    dailySpecialPrice: 199,
    regularPrice: 250,
    durationHours: 24,
    nowMs,
  });

  assert.equal(win.isDailySpecial, true);
  assert.equal(win.dailySpecialPrice, 199);
  assert.equal(win.dailySpecialExpiresAt, '2026-11-19T10:00:00.000Z');

  const item = { price: 250, ...win };
  assert.equal(isDailySpecialActive(item, nowMs + 60 * 60 * 1000), true);
  assert.equal(isDailySpecialActive(item, nowMs + 25 * 60 * 60 * 1000), false);
  assert.equal(computeDailySpecialSavingsPct(item, nowMs), 20);
  assert.match(formatDailySpecialRemaining(item, nowMs), /24h (0m )?left|23h 59m left/);

  assert.throws(
    () =>
      createDailySpecialWindow({
        enabled: true,
        dailySpecialPrice: 260,
        regularPrice: 250,
        nowMs,
      }),
    /must be lower than the regular price/
  );
});

test('qr-tools builds and parses table menu URLs and scanned QR payloads cleanly', () => {
  assert.ok(DEFAULT_TABLE_PRESETS.includes('Table 05'));
  assert.equal(FLOOR_PLAN_TABLES.length >= 12, true);
  assert.equal(tableLabelToId('Courtyard A1'), 'courtyard-a1');
  assert.equal(normalizeTableLabel('General Menu'), '');

  const url = buildTableMenuUrl({
    origin: 'https://pier25.example.com/some/path',
    tableLabel: 'Table 05',
    orderType: 'dine_in',
    sectionHash: '#interactive-menu',
  });
  assert.equal(url, 'https://pier25.example.com/?table=Table+05&orderType=dine_in#interactive-menu');

  const queryParsed = parseTableQueryFromSearch(new URL(url).search, new URL(url).hash);
  assert.equal(queryParsed.hasTable, true);
  assert.equal(queryParsed.tableLabel, 'Table 05');
  assert.equal(queryParsed.orderType, 'dine_in');

  const scannedFromUrl = parseScannedQrPayload(url);
  assert.equal(scannedFromUrl.valid, true);
  assert.equal(scannedFromUrl.tableLabel, 'Table 05');
  assert.equal(scannedFromUrl.tableId, 'table-05');
  assert.equal(scannedFromUrl.zone, 'Main Dining');

  const scannedDirect = parseScannedQrPayload('Courtyard A2');
  assert.equal(scannedDirect.valid, true);
  assert.equal(scannedDirect.tableLabel, 'Courtyard A2');
  assert.equal(scannedDirect.zone, 'Open Courtyard');

  const invalid = parseScannedQrPayload('https://evil.example.com/no-table');
  assert.equal(invalid.valid, false);
});

test('RestaurantStore manages Daily Specials, QR scanner table check-ins, dine-in orders, and Floor Plan release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pier25-specials-qr-'));
  try {
    const store = await new RestaurantStore(join(dir, 'store.json')).init();

    // 1. Seeded Artisan Brioche Burger is active as 24h Daily Special at ₹339 (vs ₹399)
    const totals = calculateCartTotals([{ id: 'artisan-brioche-burger', quantity: 1 }], store.data.menuItems, {
      orderType: 'dine_in',
    });
    assert.equal(totals.subtotal, 339);

    // 2. Owner toggles Crispy Masala Dosa onto 24h Daily Special at ₹229
    const featured = await store.setDailySpecial('crispy-masala-dosa', {
      enabled: true,
      dailySpecialPrice: 229,
      durationHours: 24,
    });
    assert.equal(featured.isDailySpecialActive, true);
    assert.equal(featured.dailySpecialPrice, 229);

    // 3. Turn it off
    const disabled = await store.setDailySpecial('crispy-masala-dosa', { enabled: false });
    assert.equal(disabled.isDailySpecialActive, false);

    // 4. Customer scans Table 05 QR code in AI Concierge Visual Search
    const checkinRes = await store.checkInTable({
      tableLabel: 'Table 05',
      guestName: 'Aarav Mehta',
      source: 'qr_scanner',
    });
    assert.equal(checkinRes.session.id, 'table-05');
    assert.equal(checkinRes.session.source, 'qr_scanner');
    assert.equal(checkinRes.floorPlan.summary.qrCheckedInCount, 1);
    assert.equal(checkinRes.floorPlan.summary.occupiedCount, 1);

    // 5. Place dine-in order for Table 05 and verify linkage on Floor Plan
    const { order } = await store.createOrder({
      user: null,
      items: [{ id: 'artisan-brioche-burger', quantity: 1 }],
      orderType: 'dine_in',
      tableNumber: 'Table 05',
      customerName: 'Aarav Mehta',
      payment: { method: 'upi', upiId: 'aarav@okicici' },
    });
    assert.equal(order.tableNumber, 'Table 05');

    const fpWithOrder = store.getFloorPlanState();
    const table5 = fpWithOrder.tables.find((t) => t.id === 'table-05');
    assert.equal(table5.status, 'occupied');
    assert.equal(table5.checkedInViaQr, true);
    assert.equal(table5.activeOrders.length, 1);
    assert.equal(table5.activeOrders[0].id, order.id);

    // Complete the order, then release table cleanly
    await store.updateOrderStatus(order.id, 'completed', { role: 'owner' });
    const releaseRes = await store.releaseTable('table-05');
    assert.equal(releaseRes.wasOccupied, true);
    assert.equal(releaseRes.floorPlan.summary.occupiedCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
