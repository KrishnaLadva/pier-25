export const DAILY_SPECIAL_DURATION_HOURS = 24;

export function roundRupees(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function isDailySpecialActive(item, nowMs = Date.now()) {
  if (!item || item.isDailySpecial !== true) return false;
  const regularPrice = Number(item.price);
  const specialPrice = Number(item.dailySpecialPrice);
  if (!Number.isFinite(regularPrice) || regularPrice <= 0) return false;
  if (!Number.isFinite(specialPrice) || specialPrice <= 0 || specialPrice >= regularPrice) {
    return false;
  }
  if (item.dailySpecialExpiresAt) {
    const expiresMs = Date.parse(item.dailySpecialExpiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      return false;
    }
  }
  return true;
}

export function getDailySpecialRemainingMs(item, nowMs = Date.now()) {
  if (!isDailySpecialActive(item, nowMs)) return 0;
  if (!item.dailySpecialExpiresAt) {
    return DAILY_SPECIAL_DURATION_HOURS * 60 * 60 * 1000;
  }
  const expiresMs = Date.parse(item.dailySpecialExpiresAt);
  return Math.max(0, expiresMs - nowMs);
}

export function formatDailySpecialRemaining(item, nowMs = Date.now()) {
  const remainingMs = getDailySpecialRemainingMs(item, nowMs);
  if (remainingMs <= 0) return '';
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 1) {
    return minutes > 0 ? `${hours}h ${minutes}m left` : `${hours}h left`;
  }
  return `${totalMinutes}m left`;
}

export function computeDailySpecialSavingsPct(item, nowMs = Date.now()) {
  if (!isDailySpecialActive(item, nowMs)) return 0;
  const regularPrice = Number(item.price);
  const specialPrice = Number(item.dailySpecialPrice);
  if (regularPrice <= 0 || specialPrice >= regularPrice) return 0;
  return Math.max(1, Math.round(((regularPrice - specialPrice) / regularPrice) * 100));
}

export function createDailySpecialWindow({
  enabled,
  dailySpecialPrice,
  regularPrice,
  durationHours = DAILY_SPECIAL_DURATION_HOURS,
  nowMs = Date.now(),
} = {}) {
  if (!enabled) {
    return {
      isDailySpecial: false,
      dailySpecialPrice: null,
      dailySpecialStartedAt: null,
      dailySpecialExpiresAt: null,
    };
  }

  const parsedRegular = Number(regularPrice);
  if (!Number.isFinite(parsedRegular) || parsedRegular <= 0) {
    throw new Error('Set a regular ₹ price on this dish before featuring it as a Daily Special.');
  }

  const parsedPromo = roundRupees(Number(dailySpecialPrice));
  if (!Number.isFinite(parsedPromo) || parsedPromo <= 0 || parsedPromo > 100000) {
    throw new Error('Daily Special promo price in ₹ must be a positive amount.');
  }
  if (parsedPromo >= parsedRegular) {
    throw new Error(`Daily Special promo price (₹${parsedPromo}) must be lower than the regular price (₹${parsedRegular}).`);
  }

  const hours = Math.max(1, Math.min(168, Number(durationHours) || DAILY_SPECIAL_DURATION_HOURS));
  const startedIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + hours * 60 * 60 * 1000).toISOString();

  return {
    isDailySpecial: true,
    dailySpecialPrice: parsedPromo,
    dailySpecialStartedAt: startedIso,
    dailySpecialExpiresAt: expiresIso,
  };
}
