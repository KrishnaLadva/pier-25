export const FLOOR_PLAN_TABLES = [
  { id: 'table-01', label: 'Table 01', zone: 'Main Dining', seats: 2, shape: 'round' },
  { id: 'table-02', label: 'Table 02', zone: 'Main Dining', seats: 2, shape: 'round' },
  { id: 'table-03', label: 'Table 03', zone: 'Main Dining', seats: 4, shape: 'square' },
  { id: 'table-04', label: 'Table 04', zone: 'Main Dining', seats: 4, shape: 'square' },
  { id: 'table-05', label: 'Table 05', zone: 'Main Dining', seats: 4, shape: 'square' },
  { id: 'table-06', label: 'Table 06', zone: 'Main Dining', seats: 4, shape: 'square' },
  { id: 'table-07', label: 'Table 07', zone: 'Main Dining', seats: 6, shape: 'banquette' },
  { id: 'table-08', label: 'Table 08', zone: 'Main Dining', seats: 6, shape: 'banquette' },
  { id: 'courtyard-a1', label: 'Courtyard A1', zone: 'Open Courtyard', seats: 4, shape: 'square' },
  { id: 'courtyard-a2', label: 'Courtyard A2', zone: 'Open Courtyard', seats: 4, shape: 'square' },
  { id: 'lounge-l1', label: 'Lounge L1', zone: 'Lounge', seats: 4, shape: 'lounge' },
  { id: 'lounge-l2', label: 'Lounge L2', zone: 'Lounge', seats: 6, shape: 'lounge' },
];

export const DEFAULT_TABLE_PRESETS = [
  'General Menu',
  ...FLOOR_PLAN_TABLES.map((t) => t.label),
];

export function normalizeTableLabel(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[^a-zA-Z0-9\s\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  if (!cleaned || /^general(\s+menu)?$/i.test(cleaned)) {
    return '';
  }
  return cleaned;
}

export function tableLabelToId(rawLabel) {
  const clean = normalizeTableLabel(rawLabel);
  if (!clean) return '';
  return clean
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

export function findFloorPlanTableMeta(rawLabel) {
  const clean = normalizeTableLabel(rawLabel);
  if (!clean) return null;
  const slug = tableLabelToId(clean);
  const preset = FLOOR_PLAN_TABLES.find(
    (t) => t.id === slug || t.label.toLowerCase() === clean.toLowerCase()
  );
  if (preset) return { ...preset, isCustom: false };
  return {
    id: slug,
    label: clean,
    zone: 'Custom Seating',
    seats: 4,
    shape: 'square',
    isCustom: true,
  };
}

export function sanitizeMenuOrigin(rawOrigin) {
  const candidate = String(rawOrigin || '').trim().replace(/\/+$/, '');
  if (!candidate) return 'http://localhost:3000';
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
  } catch {
    // Fall through to safe fallback
  }
  return 'http://localhost:3000';
}

export function buildTableMenuUrl({
  origin,
  tableLabel = '',
  orderType = 'dine_in',
  sectionHash = '#interactive-menu',
} = {}) {
  const baseOrigin = sanitizeMenuOrigin(origin);
  const cleanTable = normalizeTableLabel(tableLabel);
  const hash = String(sectionHash || '#interactive-menu').startsWith('#')
    ? sectionHash || '#interactive-menu'
    : `#${sectionHash}`;

  const url = new URL(baseOrigin);
  if (cleanTable) {
    url.searchParams.set('table', cleanTable);
    if (orderType && ['dine_in', 'pickup', 'delivery'].includes(orderType)) {
      url.searchParams.set('orderType', orderType);
    }
  }
  url.hash = hash;
  return url.toString();
}

export function parseTableQueryFromSearch(search = '', hash = '') {
  const rawSearch = String(search || '').startsWith('?') ? search.slice(1) : String(search || '');
  const params = new URLSearchParams(rawSearch);
  const tableLabel = normalizeTableLabel(params.get('table') || '');
  const rawOrderType = String(params.get('orderType') || '').trim();
  const orderType = ['dine_in', 'pickup', 'delivery'].includes(rawOrderType)
    ? rawOrderType
    : tableLabel
      ? 'dine_in'
      : '';

  return {
    hasTable: Boolean(tableLabel),
    tableLabel,
    orderType,
    openMenu: Boolean(tableLabel) || hash === '#interactive-menu',
  };
}

export function parseScannedQrPayload(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    return { valid: false, error: 'QR payload is empty.' };
  }

  // Try parsing full URL or relative URL with query parameters
  if (/^https?:\/\//i.test(text) || text.startsWith('/?') || text.startsWith('?')) {
    try {
      const parsedUrl = new URL(text, 'http://localhost:3000');
      const queryInfo = parseTableQueryFromSearch(parsedUrl.search, parsedUrl.hash);
      if (!queryInfo.hasTable) {
        return {
          valid: false,
          error: 'QR link does not specify a Pier 25 table seat.',
        };
      }
      const meta = findFloorPlanTableMeta(queryInfo.tableLabel);
      return {
        valid: true,
        tableLabel: meta ? meta.label : queryInfo.tableLabel,
        tableId: meta ? meta.id : tableLabelToId(queryInfo.tableLabel),
        zone: meta?.zone || 'Main Dining',
        orderType: 'dine_in',
        raw: text,
      };
    } catch {
      return { valid: false, error: 'Unable to parse QR code URL.' };
    }
  }

  // Try direct pier25 table string (e.g. "Table 05", "Courtyard A1", "Lounge L1", "Patio 12")
  const normalized = normalizeTableLabel(text);
  const directMatch = FLOOR_PLAN_TABLES.find(
    (t) => t.label.toLowerCase() === normalized.toLowerCase() || t.id === tableLabelToId(normalized)
  );
  if (
    directMatch ||
    /^(table|courtyard|lounge|patio|terrace|booth|bar|seat)\s*[a-z0-9\-]{1,12}$/i.test(normalized)
  ) {
    const meta = findFloorPlanTableMeta(normalized);
    return {
      valid: true,
      tableLabel: meta ? meta.label : normalized,
      tableId: meta ? meta.id : tableLabelToId(normalized),
      zone: meta?.zone || 'Main Dining',
      orderType: 'dine_in',
      raw: text,
    };
  }

  return {
    valid: false,
    error: 'Unrecognized QR code. Scan a Pier 25 table standee or paste a table link.',
  };
}
