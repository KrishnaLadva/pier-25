import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOOD_TAXONOMY,
  OWNER_EMAIL,
  RestaurantStore,
  calculateCartTotals,
  computeAnalyticsSnapshot,
  createSeedMenu,
  hashPassword,
  signSessionToken,
  verifyPassword,
  verifyPaymentSubmission,
  verifySessionToken,
} from './backend-store.mjs';

test('seed menu contains unified Coffee, Croissants, and Bakery & Desserts with owner-pending prices', () => {
  const menu = createSeedMenu();
  const coffees = menu.filter((m) => m.category === 'Coffee');
  const croissants = menu.filter((m) => m.category === 'Croissants');
  const bakery = menu.filter((m) => m.category === 'Bakery & Desserts');

  assert.equal(coffees.length, FOOD_TAXONOMY.Coffee.length);
  assert.equal(croissants.length, FOOD_TAXONOMY.Croissants.length);
  assert.equal(bakery.length, FOOD_TAXONOMY['Bakery & Desserts'].length);

  for (const item of [...coffees, ...croissants, ...bakery]) {
    assert.equal(item.price, null);
    assert.equal(item.discountPrice, null);
  }
  assert.equal(menu.find((m) => m.id === 'croissant-chicken')?.dietaryType, 'non-veg');
});

test('calculateCartTotals computes authoritative INR subtotal, promo, loyalty, GST, and free delivery', () => {
  const menu = createSeedMenu();
  const totals = calculateCartTotals(
    [
      { id: 'smoky-paneer-sizzler', quantity: 2 }, // ₹978
      { id: 'crispy-masala-dosa', quantity: 1 }, // ₹279 -> subtotal ₹1257
    ],
    menu,
    {
      orderType: 'delivery',
      promoCode: 'PIER10', // 10% = 125.70
      redeemPoints: 200, // ₹20.00
      availablePoints: 300,
    }
  );
  assert.equal(totals.subtotal, 1257);
  assert.equal(totals.promoDiscount, 125.7);
  assert.equal(totals.loyaltyDiscount, 20);
  assert.equal(totals.pointsRedeemed, 200);
  assert.equal(totals.deliveryFee, 0);
  assert.equal(totals.itemCount, 3);
  // discounted = 1257 - 125.7 - 20 = 1111.30; tax 5% = 55.57; total = 1166.87
  assert.equal(totals.tax, 55.57);
  assert.equal(totals.total, 1166.87);
});

test('calculateCartTotals rejects unpriced coffee items, unknown dishes, and invalid quantities', () => {
  const menu = createSeedMenu();
  assert.throws(
    () => calculateCartTotals([{ id: 'coffee-espresso', quantity: 1 }], menu),
    /not been set by the restaurant owner/
  );
  assert.throws(() => calculateCartTotals([{ id: 'unknown-dish', quantity: 1 }], menu), /not found/);
  assert.throws(() => calculateCartTotals([{ id: 'crispy-masala-dosa', quantity: 0 }], menu), /Invalid item quantity/);
});

test('verifyPaymentSubmission validates card, UPI, and cash on delivery', () => {
  const card = verifyPaymentSubmission({ method: 'card', cardNumber: '4242 4242 4242 4242', expiry: '12/28', cvv: '123' });
  assert.equal(card.verified, true);
  assert.equal(card.paymentStatus, 'verified');
  assert.match(card.paymentReference, /^CARD-4242-/);

  assert.throws(() => verifyPaymentSubmission({ method: 'card', cardNumber: '123', expiry: '12/28', cvv: '123' }));

  const upi = verifyPaymentSubmission({ method: 'upi', upiId: 'krishna@okbank' });
  assert.equal(upi.paymentStatus, 'verified');

  const cod = verifyPaymentSubmission({ method: 'cash_on_delivery' });
  assert.equal(cod.paymentStatus, 'pending');
});

test('password hashing and HMAC session tokens verify securely', () => {
  const hash = hashPassword('MySecret123');
  assert.equal(verifyPassword('MySecret123', hash), true);
  assert.equal(verifyPassword('WrongPass', hash), false);

  const token = signSessionToken({ uid: 'u1', role: 'owner', exp: Date.now() + 60000 }, 'test-secret');
  const parsed = verifySessionToken(token, 'test-secret');
  assert.equal(parsed.uid, 'u1');
  assert.equal(verifySessionToken(token, 'wrong-secret'), null);
});

test('RestaurantStore persists owner ₹ price updates, customisation orders, inventory deduction, and analytics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pier25-store-'));
  try {
    const store = await new RestaurantStore(join(dir, 'store.json')).init();
    assert.equal(store.data.settings.restaurantName, 'Pier 25');

    const customer = await store.registerUser({
      displayName: 'Maya Guest',
      email: 'maya@example.com',
      password: 'password123',
    });
    assert.equal(customer.role, 'customer');
    assert.equal(customer.loyaltyPoints, 50);

    const owner = await store.registerUser({
      displayName: 'Krishna Owner',
      email: OWNER_EMAIL,
      password: 'ownerpassword',
    });
    assert.equal(owner.role, 'owner');

    // Owner enters ₹180 regular, ₹150 discount, and ₹290 combo price for Espresso inside unified Food Items
    const updatedEspresso = await store.upsertMenuItem(
      { price: 180, discountPrice: 150, comboPrice: 290, comboLabel: 'Espresso + Butter Croissant' },
      'coffee-espresso'
    );
    assert.equal(updatedEspresso.price, 180);
    assert.equal(updatedEspresso.discountPrice, 150);
    assert.equal(updatedEspresso.comboPrice, 290);
    assert.equal(updatedEspresso.comboLabel, 'Espresso + Butter Croissant');

    const { order, user: updatedCustomer } = await store.createOrder({
      user: customer,
      items: [
        { id: 'smoky-paneer-sizzler', quantity: 2, pricingMode: 'combo' }, // ₹549 * 2 = ₹1098
        { id: 'coffee-espresso', quantity: 1, pricingMode: 'individual', customisations: { 'Roast Profile': 'Single-Origin Fruity' } },
      ],
      orderType: 'pickup',
      customerName: 'Maya Guest',
      payment: { method: 'upi', upiId: 'maya@okaxis' },
    });

    assert.equal(order.status, 'confirmed');
    assert.equal(order.paymentStatus, 'verified');
    assert.equal(order.subtotal, 1098 + 150);
    assert.equal(order.items[1].customisationSummary, 'Roast Profile: Single-Origin Fruity');
    assert.ok(updatedCustomer.loyaltyPoints > 50);

    // Reject combo mode when item has no comboPrice
    const baseDosa = store.data.menuItems.find((m) => m.id === 'crispy-masala-dosa');
    assert.ok(baseDosa.comboPrice > 0);
    assert.throws(
      () => calculateCartTotals([{ id: 'masala-puff-chai', quantity: 1, pricingMode: 'combo' }], store.data.menuItems),
      /Combo pricing is not available/
    );

    // Stock deducted for linked Paneer Blocks (initial 18 - 2 = 16)
    const paneer = store.data.inventory.find((i) => i.id === 'inv-paneer');
    assert.equal(paneer.stockQty, 16);

    const analytics = computeAnalyticsSnapshot(store.data);
    assert.equal(analytics.totalOrders, 1);
    assert.equal(analytics.totalRevenue, order.total);

    // Reload from disk to verify persistence
    const reloaded = await new RestaurantStore(join(dir, 'store.json')).init();
    assert.equal(reloaded.data.orders.length, 1);
    assert.equal(reloaded.data.menuItems.find((m) => m.id === 'coffee-espresso')?.discountPrice, 150);
    assert.equal(reloaded.data.menuItems.find((m) => m.id === 'coffee-espresso')?.comboPrice, 290);
    assert.equal(reloaded.findUserByEmail(OWNER_EMAIL).role, 'owner');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RestaurantStore Elite Guests leaderboard ranks by totalLoyaltyEarned without leaking PII and updates on orders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pier25-elite-'));
  try {
    const store = await new RestaurantStore(join(dir, 'store.json')).init();
    const initialBoard = store.getEliteGuestsLeaderboard({ limit: 6 });
    assert.equal(initialBoard.guests.length, 6);
    assert.equal(initialBoard.guests[0].displayName, 'Ananya Verma');
    assert.equal(initialBoard.guests[0].totalLoyaltyEarned, 1680);

    // Ensure PII fields are completely absent from public leaderboard response
    for (const g of initialBoard.guests) {
      assert.equal(g.email, undefined);
      assert.equal(g.phone, undefined);
      assert.equal(g.address, undefined);
    }

    // Register a new high-volume customer and redeem points while keeping cumulative earned intact
    const vip = await store.registerUser({
      displayName: 'Zara Kapoor',
      email: 'zara.vip@example.com',
      password: 'password123',
    });
    assert.equal(vip.totalLoyaltyEarned, 50);

    // High-value order earns > 1800 points (₹19,560 subtotal -> ~1956 points)
    await store.createOrder({
      user: vip,
      items: [{ id: 'smoky-paneer-sizzler', quantity: 40 }],
      orderType: 'pickup',
      customerName: 'Zara Kapoor',
      redeemPoints: 50,
      payment: { method: 'upi', upiId: 'zara@okbank' },
    });

    const reviewGuest = await store.findUserById(vip.uid);
    await store.addReview({
      user: store.sanitizeUser(reviewGuest),
      rating: 5,
      comment: 'Incredible sizzler catering!',
      dishId: 'smoky-paneer-sizzler',
    });

    const updatedBoard = store.getEliteGuestsLeaderboard({ limit: 6 });
    assert.equal(updatedBoard.guests[0].displayName, 'Zara Kapoor');
    assert.ok(updatedBoard.guests[0].totalLoyaltyEarned > 1900);
    assert.equal(updatedBoard.guests[0].tier, 'Grand Reserve');
    assert.equal(updatedBoard.guests[0].email, undefined);

    // Verify automated inventory threshold, acknowledgment, and restock workflows
    const chai = store.data.inventory.find((i) => i.id === 'inv-chai-pastry');
    assert.ok(chai.stockQty <= chai.reorderLevel);

    const ackRes = await store.acknowledgeInventoryAlert('inv-chai-pastry');
    assert.equal(ackRes.alertSummary.activeAlerts.some((a) => a.id === 'inv-chai-pastry'), false);

    // Raising threshold on a healthy SKU triggers a fresh alert automatically and preserves SKU/unit
    const paneerUpdate = await store.upsertInventoryItem({ reorderLevel: 25 }, 'inv-paneer');
    assert.ok(paneerUpdate.lowStockAlertAt);
    assert.equal(paneerUpdate.sku, 'KRD-102');
    assert.equal(paneerUpdate.unit, 'kg');

    // One-click restock replenishes above threshold and clears alert
    const restockRes = await store.restockInventoryItem('inv-paneer');
    assert.ok(restockRes.item.stockQty > restockRes.item.reorderLevel);
    assert.equal(restockRes.alertSummary.allAlerts.some((a) => a.id === 'inv-paneer'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


