import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyGuestTier,
  extractNeighborhood,
  classifyTasteProfile,
  buildLoyaltyPointTrendSeries,
  buildTopGuestDemographics,
  computeLoyaltyAnalytics,
} from './loyalty-analytics.js';
import { RestaurantStore } from './backend-store.mjs';

test('classifyGuestTier maps point thresholds to Pier 25 membership tiers', () => {
  assert.equal(classifyGuestTier(1240), 'Grand Reserve');
  assert.equal(classifyGuestTier(1000), 'Grand Reserve');
  assert.equal(classifyGuestTier(750), 'Gold Circle');
  assert.equal(classifyGuestTier(300), 'Forest Patron');
  assert.equal(classifyGuestTier(120), 'Club Guest');
});

test('extractNeighborhood generalizes Ahmedabad street addresses cleanly', () => {
  assert.equal(extractNeighborhood('42 Gulbai Tekra, Navrangpura, Ahmedabad'), 'Navrangpura');
  assert.equal(extractNeighborhood('18 Sindhu Bhavan Rd, Bodakdev, Ahmedabad'), 'Bodakdev');
  assert.equal(extractNeighborhood(''), 'Walk-In & Online');
  assert.equal(extractNeighborhood('12 Riverfront Way, Ellisbridge, Ahmedabad'), 'Ellisbridge');
});

test('classifyTasteProfile groups dietary & dining notes into demographic clusters', () => {
  assert.equal(classifyTasteProfile('Caramel Macchiato, Almond Croissant'), 'Coffee & Croissants');
  assert.equal(classifyTasteProfile('Jain Paneer Sizzler, Classic Butter Croissant'), 'Indian & Sizzlers');
  assert.equal(classifyTasteProfile('Vietnamese Coffee, Cold Brew'), 'Artisanal Coffee');
  assert.equal(classifyTasteProfile('Gourmet Burgers & Healthy Bowls'), 'Gourmet Burgers & Bowls');
  assert.equal(classifyTasteProfile(''), 'Chef Favorites');
});

test('buildLoyaltyPointTrendSeries handles empty stores cleanly', () => {
  const res = buildLoyaltyPointTrendSeries({ users: [], orders: [], reviews: [] });
  assert.equal(res.buckets.length, 0);
  assert.equal(res.summary.totalEarned, 0);
  assert.equal(res.summary.totalRedeemed, 0);
  assert.equal(res.summary.redemptionRatePct, 0);
});

test('buildLoyaltyPointTrendSeries yields chronological buckets and monotonic cumulative growth', () => {
  const nowMs = Date.parse('2026-11-20T00:00:00Z');
  const store = {
    users: [
      {
        uid: 'u1',
        role: 'customer',
        displayName: 'Ananya Sharma',
        loyaltyPoints: 450,
        totalLoyaltyEarned: 750,
        totalOrders: 5,
        createdAt: '2026-09-01T10:00:00Z',
        lastOrderAt: '2026-11-15T12:00:00Z',
      },
      {
        uid: 'u2',
        role: 'customer',
        displayName: 'Rohan Mehta',
        loyaltyPoints: 180,
        totalLoyaltyEarned: 280,
        totalOrders: 2,
        createdAt: '2026-10-28T10:00:00Z',
        lastOrderAt: '2026-11-18T12:00:00Z',
      },
    ],
    orders: [
      {
        id: 'o1',
        userId: 'u1',
        status: 'completed',
        pointsEarned: 80,
        pointsRedeemed: 50,
        createdAt: '2026-11-10T10:00:00Z',
      },
    ],
    reviews: [],
  };

  const allSeries = buildLoyaltyPointTrendSeries(store, { range: 'all', nowMs });
  assert.equal(allSeries.buckets.length, 8);
  assert.equal(allSeries.summary.totalEarned, 1030);
  assert.equal(allSeries.summary.activeBalance, 630);
  assert.equal(allSeries.summary.totalRedeemed, 400);
  assert.equal(allSeries.summary.redemptionRatePct, 39);

  for (let i = 1; i < allSeries.buckets.length; i += 1) {
    assert.ok(allSeries.buckets[i].cumulativeEarned >= allSeries.buckets[i - 1].cumulativeEarned);
    assert.ok(allSeries.buckets[i].timestamp > allSeries.buckets[i - 1].timestamp);
  }
  assert.equal(allSeries.buckets[allSeries.buckets.length - 1].cumulativeEarned, 1030);

  const range30 = buildLoyaltyPointTrendSeries(store, { range: '30d', nowMs });
  assert.equal(range30.buckets.length, 6);
  assert.equal(range30.range, '30d');
});

test('buildTopGuestDemographics accurately aggregates by tier, neighborhood, and taste profile', () => {
  const store = {
    users: [
      {
        uid: 'owner-1',
        role: 'owner',
        displayName: 'Owner',
        loyaltyPoints: 9999,
      },
      {
        uid: 'c1',
        role: 'customer',
        displayName: 'Meera Patel',
        address: '14 C.G. Road, Navrangpura, Ahmedabad',
        dietaryPreferences: 'Espresso, Almond Croissant',
        loyaltyPoints: 920,
        totalLoyaltyEarned: 1120,
        totalOrders: 12,
        historicalSpent: 15000,
      },
      {
        uid: 'c2',
        role: 'customer',
        displayName: 'Kabir Shah',
        address: '22 Sindhu Bhavan Rd, Bodakdev, Ahmedabad',
        dietaryPreferences: 'Paneer Sizzler',
        loyaltyPoints: 400,
        totalLoyaltyEarned: 650,
        totalOrders: 6,
        historicalSpent: 7500,
      },
    ],
    orders: [
      { id: 'ord-1', userId: 'c1', status: 'delivered', total: 1200 },
    ],
  };

  const byTier = buildTopGuestDemographics(store, { segmentBy: 'tier' });
  assert.equal(byTier.totalMembers, 2);
  assert.equal(byTier.totalPointsEarned, 1770);
  assert.equal(byTier.segments[0].label, 'Grand Reserve');
  assert.equal(byTier.topGuests[0].uid, 'c1');
  assert.equal(byTier.topGuests[0].totalSpent, 16200);

  const byArea = buildTopGuestDemographics(store, { segmentBy: 'neighborhood' });
  assert.equal(byArea.segments.find((s) => s.label === 'Navrangpura')?.count, 1);
  assert.equal(byArea.segments.find((s) => s.label === 'Bodakdev')?.count, 1);

  const byTaste = buildTopGuestDemographics(store, { segmentBy: 'preference' });
  assert.equal(byTaste.segments.find((s) => s.label === 'Coffee & Croissants')?.count, 1);
  assert.equal(byTaste.segments.find((s) => s.label === 'Indian & Sizzlers')?.count, 1);

  const clientSummaryFallback = buildTopGuestDemographics({
    users: [{ uid: 'c1', role: 'customer', displayName: 'Meera Patel', address: 'Navrangpura', loyaltyPoints: 920, totalLoyaltyEarned: 1120, totalSpent: 16200 }],
    orders: [],
  }, { segmentBy: 'neighborhood' });
  assert.equal(clientSummaryFallback.segments[0].avgSpend, 16200);
});

test('RestaurantStore.getLoyaltyAnalytics reflects new orders with earned and redeemed loyalty points', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pier25-loyalty-test-'));
  const storePath = path.join(tmpDir, 'store.json');
  const store = new RestaurantStore(storePath);
  await store.init();

  const before = store.getLoyaltyAnalytics({ range: 'all', segmentBy: 'tier' });
  assert.ok(before.trends.buckets.length >= 6);
  assert.ok(before.demographics.totalMembers >= 5);

  const seededGuest = store.data.users.find((u) => u.role === 'customer');
  assert.ok(seededGuest);
  const dish = store.data.menuItems.find((m) => Number(m.price) > 0);
  assert.ok(dish);

  const orderRes = await store.createOrder({
    user: seededGuest,
    customerName: seededGuest.displayName,
    customerPhone: seededGuest.phone,
    deliveryAddress: seededGuest.address,
    orderType: 'dine_in',
    tableNumber: 'Table 05',
    items: [{ id: dish.id, quantity: 3 }],
    redeemPoints: 40,
    payment: { method: 'cash_on_delivery' },
  });

  const after = store.getLoyaltyAnalytics({ range: '30d', segmentBy: 'neighborhood' });
  assert.equal(
    after.trends.summary.totalEarned,
    before.trends.summary.totalEarned + orderRes.order.pointsEarned
  );
  assert.ok(after.trends.summary.totalRedeemed >= before.trends.summary.totalRedeemed + 40);

  const analyticsBundle = computeLoyaltyAnalytics(store.data, { range: '90d', segmentBy: 'preference' });
  assert.equal(analyticsBundle.trends.range, '90d');
  assert.equal(analyticsBundle.demographics.activeDimension, 'preference');
});
