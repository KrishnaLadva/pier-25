import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBooking,
  createBookingRecord,
  formatTime12h,
  parseStoredBookings,
  removeBookingById,
} from './booking.js';

test('validateBooking rejects empty fields with specific errors', () => {
  const result = validateBooking(
    { name: '', date: '', time: '', partySize: '' },
    '2026-11-16'
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.name);
  assert.ok(result.errors.date);
  assert.ok(result.errors.time);
  assert.ok(result.errors.partySize);
});

test('validateBooking rejects past dates and out-of-range party sizes', () => {
  const result = validateBooking(
    { name: 'A', date: '2026-11-10', time: '19:30', partySize: '25' },
    '2026-11-16'
  );
  assert.equal(result.valid, false);
  assert.match(result.errors.name, /at least 2/);
  assert.match(result.errors.date, /today or a future/);
  assert.equal(result.errors.time, undefined);
  assert.match(result.errors.partySize, /between 1 and 20/);
});

test('validateBooking accepts valid future reservation and normalizes values', () => {
  const result = validateBooking(
    { name: '  Aarav Patel  ', date: '2026-12-20', time: '19:30', partySize: '4' },
    '2026-11-16'
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.normalized, {
    name: 'Aarav Patel',
    date: '2026-12-20',
    time: '19:30',
    partySize: 4,
  });
});

test('createBookingRecord and removeBookingById manage reservation records', () => {
  const record = createBookingRecord(
    { name: 'Maya', date: '2026-12-01', time: '18:00', partySize: 2 },
    'KRZ-TEST1'
  );
  assert.equal(record.id, 'KRZ-TEST1');
  assert.equal(record.partySize, 2);

  const remaining = removeBookingById([record], 'KRZ-TEST1');
  assert.deepEqual(remaining, []);
});

test('formatTime12h converts 24h time strings cleanly', () => {
  assert.equal(formatTime12h('00:15'), '12:15 AM');
  assert.equal(formatTime12h('12:00'), '12:00 PM');
  assert.equal(formatTime12h('19:30'), '7:30 PM');
});

test('parseStoredBookings handles malformed JSON safely', () => {
  assert.deepEqual(parseStoredBookings('not-json'), []);
  assert.deepEqual(parseStoredBookings('{"not":"array"}'), []);
  const validJson = JSON.stringify([
    { id: 'KRZ-1', name: 'Sam', date: '2026-12-05', time: '20:00', partySize: 3 },
    { broken: true },
  ]);
  assert.equal(parseStoredBookings(validJson).length, 1);
});
