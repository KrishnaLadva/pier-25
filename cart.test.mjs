import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addItemToCart,
  buildCartKey,
  computeLocalCartPreview,
  getCartTotalCount,
  getComboItemPrice,
  getEffectiveItemPrice,
  parseStoredCart,
  removeCartItem,
  updateCartItemQty,
} from './cart-checkout.js';

test('cart state helpers handle INR pricing, discountPrice, comboPrice, customisations, and unpriced items', () => {
  let cart = [];
  // Unpriced coffee item must not be added to cart
  cart = addItemToCart(cart, { id: 'coffee-espresso', name: 'Espresso', price: null, imageUrl: 'x.jpg' }, 1);
  assert.equal(cart.length, 0);

  // Discounted item uses effective discountPrice in individual mode and comboPrice in combo mode
  const dish = {
    id: 'dosa',
    name: 'Crispy Masala Dosa',
    price: 279,
    discountPrice: 249,
    comboPrice: 349,
    comboLabel: 'Dosa + Filter Coffee',
    imageUrl: 'dosa.jpg',
  };
  assert.equal(getEffectiveItemPrice(dish, 'individual'), 249);
  assert.equal(getComboItemPrice(dish), 349);
  assert.equal(getEffectiveItemPrice(dish, 'combo'), 349);

  cart = addItemToCart(cart, dish, 1);
  cart = addItemToCart(cart, dish, 2);
  cart = addItemToCart(cart, dish, 1, null, 'combo');
  assert.equal(cart.length, 2);
  assert.equal(cart[0].price, 249);
  assert.equal(cart[0].quantity, 3);
  assert.equal(cart[1].pricingMode, 'combo');
  assert.equal(cart[1].price, 349);
  assert.equal(cart[1].comboLabel, 'Dosa + Filter Coffee');
  assert.equal(getCartTotalCount(cart), 4);

  // Separate cart entries for distinct customisation variants
  const cappuccino = { id: 'coffee-cappuccino', name: 'Cappuccino', price: 220, imageUrl: 'c.jpg' };
  cart = addItemToCart(cart, cappuccino, 1, { 'Milk Choice': 'Dairy' });
  cart = addItemToCart(cart, cappuccino, 1, { 'Milk Choice': 'Oat Milk' });
  assert.equal(cart.length, 4);

  cart = updateCartItemQty(cart, buildCartKey('coffee-cappuccino', { 'Milk Choice': 'Oat Milk' }), 2);
  assert.equal(getCartTotalCount(cart), 7);

  cart = removeCartItem(cart, buildCartKey('dosa', null, 'individual'));
  assert.equal(cart.length, 3);
});

test('computeLocalCartPreview calculates INR subtotal, 5% GST, and ₹499 free delivery threshold', () => {
  const small = computeLocalCartPreview([{ price: 200, quantity: 1 }], { orderType: 'delivery' });
  assert.equal(small.subtotal, 200);
  assert.equal(small.tax, 10);
  assert.equal(small.deliveryFee, 40);
  assert.equal(small.total, 250);

  const large = computeLocalCartPreview([{ price: 500, quantity: 1 }], { orderType: 'delivery' });
  assert.equal(large.deliveryFee, 0);
  assert.equal(large.tax, 25);
  assert.equal(large.total, 525);
});

test('parseStoredCart rejects corrupted JSON gracefully', () => {
  assert.deepEqual(parseStoredCart('{bad'), []);
  assert.deepEqual(parseStoredCart(JSON.stringify([{ id: 'x', name: 'X', price: 150, quantity: 0 }])), []);
  assert.deepEqual(parseStoredCart(JSON.stringify([{ id: 'x', name: 'X', price: null, quantity: 1 }])), []);
  assert.equal(
    parseStoredCart(JSON.stringify([{ id: 'x', name: 'X', price: 150, quantity: 2 }])).length,
    1
  );
});

test('getEffectiveItemPrice prioritizes active 24h Daily Special price and reverts after expiry', () => {
  const nowMs = Date.parse('2026-11-17T10:00:00.000Z');
  const dish = {
    id: 'crispy-masala-dosa',
    name: 'Crispy Masala Dosa',
    price: 279,
    discountPrice: 249,
    comboPrice: 349,
    isDailySpecial: true,
    dailySpecialPrice: 219,
    dailySpecialStartedAt: '2026-11-17T08:00:00.000Z',
    dailySpecialExpiresAt: '2026-11-18T08:00:00.000Z',
  };

  assert.equal(getEffectiveItemPrice(dish, 'individual', nowMs), 219);
  assert.equal(getEffectiveItemPrice(dish, 'combo', nowMs), 349);

  // Once 24h window expires, falls back to discountPrice or regular price
  const afterExpiryMs = Date.parse('2026-11-18T09:00:00.000Z');
  assert.equal(getEffectiveItemPrice(dish, 'individual', afterExpiryMs), 249);
});

