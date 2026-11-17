export const MIN_PARTY_SIZE = 1;
export const MAX_PARTY_SIZE = 20;
export const STORAGE_KEY = 'krazzy_table_bookings';

export function getTodayDateString(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function validateBooking(input, todayStr = getTodayDateString()) {
  const errors = {};
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const date = typeof input?.date === 'string' ? input.date.trim() : '';
  const time = typeof input?.time === 'string' ? input.time.trim() : '';
  const rawPartySize = input?.partySize;
  const partySize = Number(rawPartySize);

  if (!name) {
    errors.name = 'Please enter your name.';
  } else if (name.length < 2) {
    errors.name = 'Name must be at least 2 characters.';
  }

  if (!date) {
    errors.date = 'Please choose a reservation date.';
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errors.date = 'Please enter a valid date.';
  } else if (date < todayStr) {
    errors.date = 'Please choose today or a future date.';
  }

  if (!time) {
    errors.time = 'Please choose a reservation time.';
  } else if (!/^\d{2}:\d{2}$/.test(time)) {
    errors.time = 'Please enter a valid time.';
  }

  if (rawPartySize === '' || rawPartySize === null || rawPartySize === undefined) {
    errors.partySize = 'Please enter the party size.';
  } else if (!Number.isInteger(partySize) || partySize < MIN_PARTY_SIZE || partySize > MAX_PARTY_SIZE) {
    errors.partySize = `Party size must be between ${MIN_PARTY_SIZE} and ${MAX_PARTY_SIZE}.`;
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    normalized: {
      name,
      date,
      time,
      partySize,
    },
  };
}

export function createBookingRecord(normalizedInput, id = `KRZ-${Date.now().toString(36).toUpperCase()}`) {
  return {
    id,
    name: normalizedInput.name,
    date: normalizedInput.date,
    time: normalizedInput.time,
    partySize: normalizedInput.partySize,
    createdAt: new Date().toISOString(),
  };
}

export function formatTime12h(time24) {
  if (!/^\d{2}:\d{2}$/.test(time24)) return time24;
  const [hourStr, minuteStr] = time24.split(':');
  const hour = Number(hourStr);
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${minuteStr} ${period}`;
}

export function parseStoredBookings(rawJson) {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.date === 'string' &&
        typeof item.time === 'string' &&
        Number.isInteger(item.partySize)
    );
  } catch {
    return [];
  }
}

export function removeBookingById(bookings, id) {
  return bookings.filter((booking) => booking.id !== id);
}
