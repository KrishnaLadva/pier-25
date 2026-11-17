import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addItemToCart,
  buildCartKey,
  computeLocalCartPreview,
  getCartTotalCount,
  getEffectiveItemPrice,
  parseStoredCart,
  removeCartItem,
  updateCartItemQty,
} from './cart-checkout.js';

test('cart state helpers handle INR pricing, discountPrice, customisations, and unpriced items', () => {
  let cart = [];
  // Unpriced coffee item must not be added to cart
  cart = addItemToCart(cart, { id: 'coffee-espresso', name: 'Espresso', price: null, imageUrl: 'x.jpg' }, 1);
  assert.equal(cart.length, 0);

  // Discounted item uses effective discountPrice
  const dish = { id: 'dosa', name: 'Crispy Masala Dosa', price: 279, discountPrice: 249, imageUrl: 'dosa.jpg' };
  assert.equal(getEffectiveItemPrice(dish), 249);
  cart = addItemToCart(cart, dish, 1);
  cart = addItemToCart(cart, dish, 2);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].price, 249);
  assert.equal(cart[0].quantity, 3);
  assert.equal(getCartTotalCount(cart), 3);

  // Separate cart entries for distinct customisation variants
  const cappuccino = { id: 'coffee-cappuccino', name: 'Cappuccino', price: 220, imageUrl: 'c.jpg' };
  cart = addItemToCart(cart, cappuccino, 1, { 'Milk Choice': 'Dairy' });
  cart = addItemToCart(cart, cappuccino, 1, { 'Milk Choice': 'Oat Milk' });
  assert.equal(cart.length, 3);

  cart = updateCartItemQty(cart, buildCartKey('coffee-cappuccino', { 'Milk Choice': 'Oat Milk' }), 2);
  assert.equal(getCartTotalCount(cart), 6);

  cart = removeCartItem(cart, 'dosa');
  assert.equal(cart.length, 2);
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
