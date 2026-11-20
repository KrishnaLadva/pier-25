const DAY_MS = 24 * 60 * 60 * 1000;

export function classifyGuestTier(totalLoyaltyEarned = 0) {
  const pts = Number(totalLoyaltyEarned || 0);
  if (pts >= 1000) return 'Grand Reserve';
  if (pts >= 600) return 'Gold Circle';
  if (pts >= 300) return 'Forest Patron';
  return 'Club Guest';
}

const KNOWN_DISTRICTS = [
  { match: /navrangpura|gulbai/i, label: 'Navrangpura' },
  { match: /bodakdev|sindhu\s*bhavan/i, label: 'Bodakdev' },
  { match: /prahlad\s*nagar/i, label: 'Prahlad Nagar' },
  { match: /satellite/i, label: 'Satellite' },
  { match: /cg\s*road|c\.g\.\s*road/i, label: 'CG Road' },
  { match: /thaltej/i, label: 'Thaltej' },
  { match: /vastrapur/i, label: 'Vastrapur' },
  { match: /sg\s*highway|s\.g\./i, label: 'SG Highway' },
  { match: /maninagar/i, label: 'Maninagar' },
];

export function extractNeighborhood(address = '') {
  const clean = String(address || '').trim();
  if (!clean) return 'Walk-In & Online';
  for (const d of KNOWN_DISTRICTS) {
    if (d.match.test(clean)) return d.label;
  }
  const parts = clean
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^(ahmedabad|india|gujarat)$/i.test(s));
  if (parts.length >= 2) {
    return parts[parts.length - 1].replace(/^\d+\s+/, '').slice(0, 26) || 'Greater Ahmedabad';
  }
  return 'Greater Ahmedabad';
}

export function classifyTasteProfile(preference = '') {
  const text = String(preference || '').toLowerCase();
  if (!text) return 'Chef Favorites';
  const hasCoffee = /espresso|latte|brew|coffee|macchiato|mocha|cappuccino|americano/.test(text);
  const hasBakery = /croissant|cinnamon|muffin|tiramisu|brownie|cheesecake|danish|cookie/.test(text);
  const hasIndian = /dosa|sizzler|paneer|thepla|puff|chai/.test(text);
  const hasBowlsBurgers = /burger|bowl|wrap|combo|fries/.test(text);

  if (hasIndian) return 'Indian & Sizzlers';
  if (hasBowlsBurgers && hasCoffee) return 'Burgers & Café';
  if (hasCoffee && hasBakery) return 'Coffee & Croissants';
  if (hasCoffee) return 'Artisanal Coffee';
  if (hasBakery) return 'Viennoiserie & Bakery';
  if (hasBowlsBurgers) return 'Gourmet Burgers & Bowls';
  return 'Chef Favorites';
}

function toSafeMs(isoStr, fallbackMs) {
  const parsed = Date.parse(isoStr || '');
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function collectLoyaltyEvents(store, nowMs) {
  const users = (store?.users || []).filter((u) => u.role === 'customer');
  const orders = (store?.orders || []).filter((o) => o.status !== 'cancelled');
  const reviews = store?.reviews || [];

  const liveEarnedByUser = new Map();
  const liveRedeemedByUser = new Map();
  const events = [];

  for (const order of orders) {
    const ts = toSafeMs(order.createdAt, nowMs);
    const earned = Math.max(0, Number(order.pointsEarned || 0));
    const redeemed = Math.max(0, Number(order.pointsRedeemed || 0));
    if (order.userId) {
      liveEarnedByUser.set(order.userId, (liveEarnedByUser.get(order.userId) || 0) + earned);
      liveRedeemedByUser.set(order.userId, (liveRedeemedByUser.get(order.userId) || 0) + redeemed);
    }
    if (earned > 0 || redeemed > 0) {
      events.push({ ts, earned, redeemed, kind: 'order' });
    }
  }

  for (const rev of reviews) {
    if (!rev.userId || rev.id?.startsWith('rev-')) continue;
    const ts = toSafeMs(rev.createdAt, nowMs);
    events.push({ ts, earned: 15, redeemed: 0, kind: 'review' });
    liveEarnedByUser.set(rev.userId, (liveEarnedByUser.get(rev.userId) || 0) + 15);
  }

  // Reconcile historical earned & redeemed loyalty milestones across customer membership spans
  for (const user of users) {
    const totalEarned = Math.max(
      Number(user.loyaltyPoints || 0),
      Number(user.totalLoyaltyEarned ?? user.loyaltyPoints ?? 0)
    );
    const liveEarned = liveEarnedByUser.get(user.uid) || 0;
    const historicalEarned = Math.max(0, totalEarned - liveEarned);

    const liveRedeemed = liveRedeemedByUser.get(user.uid) || 0;
    const estimatedTotalRedeemed = Math.max(0, totalEarned - Number(user.loyaltyPoints || 0));
    const historicalRedeemed = Math.max(0, estimatedTotalRedeemed - liveRedeemed);

    if (historicalEarned === 0 && historicalRedeemed === 0) continue;

    const startMs = Math.min(nowMs, toSafeMs(user.createdAt, nowMs - 60 * DAY_MS));
    const endMs = Math.max(startMs, Math.min(nowMs, toSafeMs(user.lastOrderAt || user.updatedAt, nowMs)));

    // First milestone: 50 pt signup bonus at account creation (capped by historicalEarned)
    const signupEarned = Math.min(50, historicalEarned);
    if (signupEarned > 0) {
      events.push({ ts: startMs, earned: signupEarned, redeemed: 0, kind: 'signup' });
    }

    const remainingEarned = Math.max(0, historicalEarned - signupEarned);
    const steps = Math.max(1, Math.min(6, Number(user.totalOrders || 4)));
    const span = Math.max(DAY_MS, endMs - startMs);

    let earnedAllocated = 0;
    let redeemedAllocated = 0;
    for (let i = 1; i <= steps; i += 1) {
      const ratio = i / steps;
      const stepTs = Math.round(startMs + span * ratio);
      const stepEarned =
        i === steps
          ? remainingEarned - earnedAllocated
          : Math.round(remainingEarned / steps);
      const stepRedeemed =
        i === steps
          ? historicalRedeemed - redeemedAllocated
          : Math.round(historicalRedeemed / steps);

      earnedAllocated += stepEarned;
      redeemedAllocated += stepRedeemed;
      if (stepEarned > 0 || stepRedeemed > 0) {
        events.push({ ts: stepTs, earned: Math.max(0, stepEarned), redeemed: Math.max(0, stepRedeemed), kind: 'historical' });
      }
    }
  }

  return events.sort((a, b) => a.ts - b.ts);
}

function formatShortDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function buildLoyaltyPointTrendSeries(store, { range = 'all', nowMs = Date.now() } = {}) {
  const users = (store?.users || []).filter((u) => u.role === 'customer');
  const events = collectLoyaltyEvents(store, nowMs);

  const totalEarnedAll = users.reduce(
    (sum, u) => sum + Math.max(Number(u.loyaltyPoints || 0), Number(u.totalLoyaltyEarned ?? u.loyaltyPoints ?? 0)),
    0
  );
  const activeBalanceAll = users.reduce((sum, u) => sum + Number(u.loyaltyPoints || 0), 0);
  const totalRedeemedAll = Math.max(0, totalEarnedAll - activeBalanceAll);

  if (events.length === 0) {
    return {
      range,
      buckets: [],
      summary: {
        totalEarned: totalEarnedAll,
        totalRedeemed: totalRedeemedAll,
        activeBalance: activeBalanceAll,
        avgPerGuest: users.length > 0 ? Math.round(totalEarnedAll / users.length) : 0,
        redemptionRatePct: 0,
      },
    };
  }

  const latestEventMs = events[events.length - 1].ts;
  const anchorEndMs = Math.max(nowMs, latestEventMs);
  const earliestEventMs = events[0].ts;

  let windowStartMs = earliestEventMs;
  let bucketCount = 8;
  if (range === '30d') {
    windowStartMs = anchorEndMs - 30 * DAY_MS;
    bucketCount = 6;
  } else if (range === '90d') {
    windowStartMs = anchorEndMs - 90 * DAY_MS;
    bucketCount = 7;
  } else {
    windowStartMs = Math.min(earliestEventMs, anchorEndMs - 90 * DAY_MS);
    bucketCount = 8;
  }

  const spanMs = Math.max(bucketCount * DAY_MS, anchorEndMs - windowStartMs);
  const stepMs = spanMs / bucketCount;

  const buckets = Array.from({ length: bucketCount }, (_, idx) => {
    const start = Math.round(windowStartMs + idx * stepMs);
    const end = idx === bucketCount - 1 ? anchorEndMs + 1 : Math.round(windowStartMs + (idx + 1) * stepMs);
    const mid = Math.round((start + Math.min(end, anchorEndMs)) / 2);
    return {
      key: `b-${idx}`,
      label: formatShortDate(mid),
      rangeLabel: `${formatShortDate(start)} – ${formatShortDate(Math.min(end, anchorEndMs))}`,
      startMs: start,
      endMs: end,
      timestamp: mid,
      earned: 0,
      redeemed: 0,
      net: 0,
      cumulativeEarned: 0,
    };
  });

  let baselineEarned = 0;
  for (const ev of events) {
    if (ev.ts < windowStartMs) {
      baselineEarned += ev.earned;
      continue;
    }
    const rawIdx = Math.floor((ev.ts - windowStartMs) / stepMs);
    const idx = Math.max(0, Math.min(bucketCount - 1, rawIdx));
    buckets[idx].earned += ev.earned;
    buckets[idx].redeemed += ev.redeemed;
  }

  let runningEarned = baselineEarned;
  for (const b of buckets) {
    b.net = b.earned - b.redeemed;
    runningEarned += b.earned;
    b.cumulativeEarned = runningEarned;
  }

  const windowEarned = buckets.reduce((s, b) => s + b.earned, 0);
  const windowRedeemed = buckets.reduce((s, b) => s + b.redeemed, 0);

  return {
    range,
    buckets,
    summary: {
      totalEarned: totalEarnedAll,
      totalRedeemed: totalRedeemedAll,
      windowEarned,
      windowRedeemed,
      activeBalance: activeBalanceAll,
      avgPerGuest: users.length > 0 ? Math.round(totalEarnedAll / users.length) : 0,
      redemptionRatePct: totalEarnedAll > 0 ? Math.round((totalRedeemedAll / totalEarnedAll) * 100) : 0,
    },
  };
}

function groupByDimension(enrichedGuests, keyFn, orderedLabels = []) {
  const map = new Map();
  for (const g of enrichedGuests) {
    const label = keyFn(g);
    const entry = map.get(label) || {
      label,
      count: 0,
      totalPoints: 0,
      availablePoints: 0,
      totalSpent: 0,
      totalOrders: 0,
    };
    entry.count += 1;
    entry.totalPoints += g.totalLoyaltyEarned;
    entry.availablePoints += g.loyaltyPoints;
    entry.totalSpent += g.totalSpent;
    entry.totalOrders += g.totalOrders;
    map.set(label, entry);
  }

  const totalMembers = Math.max(1, enrichedGuests.length);
  const totalPointsAll = Math.max(1, enrichedGuests.reduce((s, g) => s + g.totalLoyaltyEarned, 0));

  const list = [...map.values()].map((item) => ({
    ...item,
    sharePct: Math.round((item.count / totalMembers) * 100),
    pointsSharePct: Math.round((item.totalPoints / totalPointsAll) * 100),
    avgSpend: item.count > 0 ? Math.round(item.totalSpent / item.count) : 0,
    avgPoints: item.count > 0 ? Math.round(item.totalPoints / item.count) : 0,
  }));

  if (orderedLabels.length > 0) {
    const orderIdx = new Map(orderedLabels.map((lbl, idx) => [lbl, idx]));
    list.sort((a, b) => {
      const ia = orderIdx.has(a.label) ? orderIdx.get(a.label) : 99;
      const ib = orderIdx.has(b.label) ? orderIdx.get(b.label) : 99;
      if (ia !== ib) return ia - ib;
      return b.totalPoints - a.totalPoints;
    });
  } else {
    list.sort((a, b) => b.totalPoints - a.totalPoints || b.count - a.count);
  }

  return list;
}

export function buildTopGuestDemographics(store, { segmentBy = 'tier', topLimit = 6 } = {}) {
  const orders = (store?.orders || []).filter((o) => o.status !== 'cancelled');
  const spendByUser = new Map();
  for (const o of orders) {
    if (!o.userId) continue;
    spendByUser.set(o.userId, (spendByUser.get(o.userId) || 0) + Number(o.total || 0));
  }

  const customers = (store?.users || [])
    .filter((u) => u.role === 'customer')
    .map((u) => {
      const loyaltyPoints = Number(u.loyaltyPoints || 0);
      const totalLoyaltyEarned = Math.max(loyaltyPoints, Number(u.totalLoyaltyEarned ?? loyaltyPoints));
      const liveOrderSpend = spendByUser.get(u.uid) || 0;
      const totalSpent =
        u.historicalSpent !== undefined
          ? Math.round(liveOrderSpend + Number(u.historicalSpent || 0))
          : Math.round(Math.max(liveOrderSpend, Number(u.totalSpent || 0)));
      const tier = classifyGuestTier(totalLoyaltyEarned);
      const neighborhood = extractNeighborhood(u.address);
      const tasteProfile = classifyTasteProfile(u.dietaryPreferences);
      const parts = String(u.displayName || 'Guest').trim().split(/\s+/);
      const initials =
        parts.length >= 2
          ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
          : String(u.displayName || 'G').slice(0, 2).toUpperCase();

      return {
        uid: u.uid,
        displayName: u.displayName || 'Pier 25 Guest',
        initials,
        tier,
        neighborhood,
        tasteProfile,
        loyaltyPoints,
        totalLoyaltyEarned,
        redeemedPoints: Math.max(0, totalLoyaltyEarned - loyaltyPoints),
        totalOrders: Number(u.totalOrders || 0),
        totalSpent,
      };
    })
    .sort((a, b) => b.totalLoyaltyEarned - a.totalLoyaltyEarned || b.totalOrders - a.totalOrders);

  const byTier = groupByDimension(
    customers,
    (g) => g.tier,
    ['Grand Reserve', 'Gold Circle', 'Forest Patron', 'Club Guest']
  );
  const byNeighborhood = groupByDimension(customers, (g) => g.neighborhood);
  const byPreference = groupByDimension(customers, (g) => g.tasteProfile);

  const activeSegments =
    segmentBy === 'neighborhood'
      ? byNeighborhood
      : segmentBy === 'preference'
        ? byPreference
        : byTier;

  const totalPointsEarned = customers.reduce((s, g) => s + g.totalLoyaltyEarned, 0);
  const totalOrders = customers.reduce((s, g) => s + g.totalOrders, 0);

  return {
    activeDimension: segmentBy,
    totalMembers: customers.length,
    totalPointsEarned,
    avgOrdersPerGuest: customers.length > 0 ? Number((totalOrders / customers.length).toFixed(1)) : 0,
    segments: activeSegments,
    dimensions: {
      tier: byTier,
      neighborhood: byNeighborhood,
      preference: byPreference,
    },
    topGuests: customers.slice(0, Math.max(1, Math.min(10, Number(topLimit) || 6))),
  };
}

export function computeLoyaltyAnalytics(store, { range = 'all', segmentBy = 'tier', nowMs = Date.now() } = {}) {
  return {
    trends: buildLoyaltyPointTrendSeries(store, { range, nowMs }),
    demographics: buildTopGuestDemographics(store, { segmentBy }),
    generatedAt: new Date(nowMs).toISOString(),
  };
}
