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

    // Owner enters ₹180 regular and ₹150 discount price for Espresso inside unified Food Items
    const updatedEspresso = await store.upsertMenuItem({ price: 180, discountPrice: 150 }, 'coffee-espresso');
    assert.equal(updatedEspresso.price, 180);
    assert.equal(updatedEspresso.discountPrice, 150);

    const { order, user: updatedCustomer } = await store.createOrder({
      user: customer,
      items: [
        { id: 'smoky-paneer-sizzler', quantity: 2 },
        { id: 'coffee-espresso', quantity: 1, customisations: { 'Roast Profile': 'Single-Origin Fruity' } },
      ],
      orderType: 'pickup',
      customerName: 'Maya Guest',
      payment: { method: 'upi', upiId: 'maya@okaxis' },
    });

    assert.equal(order.status, 'confirmed');
    assert.equal(order.paymentStatus, 'verified');
    assert.equal(order.subtotal, 978 + 150);
    assert.equal(order.items[1].customisationSummary, 'Roast Profile: Single-Origin Fruity');
    assert.ok(updatedCustomer.loyaltyPoints > 50);

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
    assert.equal(reloaded.findUserByEmail(OWNER_EMAIL).role, 'owner');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
