/**
 * Store operating hours → whether customers can order right now.
 * Normalizes JSON from `stores.operating_hours` (merchant onboarding, PATCH, or manual DB edits).
 *
 * Supported shapes:
 * - { timezone?, monday: { open, close }, ... }  (from StoreDetailsScreen / onboarding)
 * - { timezone?, weekly: { monday: {...} } } | { schedule: {...} } | { days: {...} }
 * - { every_day: { open, close } } (applied to all weekdays present or all 7 if used alone)
 * - Per-day string: "08:00-20:00" or { hours: "08:00-20:00" }
 * - Aliases: opens_at/closes_at, start/end, from/to
 * - JSON string (if driver returns string)
 * - Array: [{ day: "monday", open, close }]
 */

const DEFAULT_TZ = 'Africa/Harare';

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

function capitalizeDay(dayKey) {
  return dayKey ? dayKey.charAt(0).toUpperCase() + dayKey.slice(1) : '';
}

function parseTimeToMinutes(str) {
  if (str == null) return null;
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return h * 60 + min;
}

/** "08:00-20:00" or "08:00 - 20:00" */
function parseHoursRangeString(str) {
  if (!str || typeof str !== 'string') return { open: null, close: null };
  const m = str
    .trim()
    .match(/^(\d{1,2}:\d{2})\s*[\u2013\-–]\s*(\d{1,2}:\d{2})$/);
  if (!m) return { open: null, close: null };
  return { open: m[1], close: m[2] };
}

function getWeekdayKey(date, timeZone) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date);
  return String(wd).toLowerCase();
}

function getMinutesInTimezone(date, timeZone) {
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  const parts = hm.split(':');
  if (parts.length < 2) return 0;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function coerceRootObject(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return typeof p === 'object' && p !== null ? p : null;
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw)) {
    const map = {};
    let tz = null;
    raw.forEach((row) => {
      if (!row || typeof row !== 'object') return;
      const dk = String(row.day || row.weekday || '').toLowerCase();
      if (WEEKDAYS.includes(dk)) {
        map[dk] = row;
        if (row.timezone || row.tz) tz = row.timezone || row.tz;
      }
    });
    if (Object.keys(map).length === 0) return null;
    return { ...map, timezone: tz || undefined };
  }
  if (typeof raw === 'object') return raw;
  return null;
}

/**
 * Read one day's value from merged sources (flat + weekly + schedule + days).
 */
function pickDayRaw(oh, dayKey) {
  if (!oh || typeof oh !== 'object') return undefined;
  const cap = capitalizeDay(dayKey);
  return (
    oh[dayKey] ??
    oh[cap] ??
    oh.weekly?.[dayKey] ??
    oh.weekly?.[cap] ??
    oh.schedule?.[dayKey] ??
    oh.schedule?.[cap] ??
    oh.days?.[dayKey] ??
    oh.days?.[cap]
  );
}

/**
 * @returns {{ open: string|null, close: string|null, closed: boolean }}
 */
function normalizeDaySlot(raw) {
  if (raw == null) return { open: null, close: null, closed: false };

  if (typeof raw === 'string') {
    const r = parseHoursRangeString(raw);
    if (r.open && r.close) return { open: r.open, close: r.close, closed: false };
    return { open: null, close: null, closed: false };
  }

  if (typeof raw !== 'object') return { open: null, close: null, closed: false };

  if (raw.closed === true || raw.is_closed === true) {
    return { open: null, close: null, closed: true };
  }

  let open =
    raw.open ??
    raw.opens_at ??
    raw.start ??
    raw.from ??
    null;
  let close =
    raw.close ??
    raw.closes_at ??
    raw.end ??
    raw.to ??
    null;

  if (typeof raw.hours === 'string' && (!open || !close)) {
    const r = parseHoursRangeString(raw.hours);
    open = open || r.open;
    close = close || r.close;
  }

  if (open != null && typeof open !== 'string') open = String(open);
  if (close != null && typeof close !== 'string') close = String(close);

  return {
    open: open || null,
    close: close || null,
    closed: false,
  };
}

/**
 * Build per-day map from DB object. Returns null if nothing looks like a schedule.
 */
function buildDayMapFromOperatingHours(oh) {
  const root = coerceRootObject(oh);
  if (!root || typeof root !== 'object') return null;

  const tz = String(root.timezone || root.tz || DEFAULT_TZ).trim() || DEFAULT_TZ;
  const days = {};

  const every = root.every_day;

  if (every && typeof every === 'object' && every.closed === true) {
    for (const d of WEEKDAYS) {
      days[d] = { closed: true };
    }
    return { timezone: tz, days };
  }

  const useEvery =
    every &&
    typeof every === 'object' &&
    !every.closed &&
    (every.open || every.close || every.hours);

  for (const d of WEEKDAYS) {
    let raw = pickDayRaw(root, d);
    if (raw === undefined && useEvery) raw = every;
    if (raw === undefined) continue;

    const slot = normalizeDaySlot(raw);
    if (slot.closed) {
      days[d] = { closed: true };
      continue;
    }
    if (slot.open && slot.close) {
      days[d] = { open: slot.open, close: slot.close };
    }
  }

  if (Object.keys(days).length === 0) return null;

  return { timezone: tz, days };
}

/**
 * @returns {{ accepting: boolean, reason: 'inactive'|'manual_closed'|'outside_hours'|null, message: string }}
 */
export function getStoreOrderEligibility(store, now = new Date()) {
  if (!store) {
    return { accepting: false, reason: 'inactive', message: 'Store not found.' };
  }
  if (store.is_active === false) {
    return { accepting: false, reason: 'inactive', message: 'This store is not available.' };
  }
  if (store.is_open === false) {
    return {
      accepting: false,
      reason: 'manual_closed',
      message: 'This store is closed right now.',
    };
  }

  const normalized = buildDayMapFromOperatingHours(store.operating_hours);

  if (!normalized) {
    const accepting = store.is_open !== false;
    return {
      accepting,
      reason: accepting ? null : 'manual_closed',
      message: accepting ? '' : 'This store is closed right now.',
    };
  }

  const { timezone: tz, days } = normalized;
  const dayKey = getWeekdayKey(now, tz);
  const day = days[dayKey];

  // Schedule exists for the week but this weekday has no row → treat as closed (not legacy is_open).
  if (day === undefined && Object.keys(days).length > 0) {
    return {
      accepting: false,
      reason: 'outside_hours',
      message: 'This store is closed today.',
    };
  }

  if (day === undefined) {
    const accepting = store.is_open !== false;
    return {
      accepting,
      reason: accepting ? null : 'manual_closed',
      message: accepting ? '' : 'This store is closed right now.',
    };
  }

  if (day.closed === true) {
    return {
      accepting: false,
      reason: 'outside_hours',
      message: 'This store is closed today.',
    };
  }

  const openM = parseTimeToMinutes(day.open);
  const closeM = parseTimeToMinutes(day.close);

  if (openM == null || closeM == null) {
    const accepting = store.is_open !== false;
    return {
      accepting,
      reason: accepting ? null : 'manual_closed',
      message: accepting ? '' : 'This store is closed right now.',
    };
  }

  const cur = getMinutesInTimezone(now, tz);
  let inside;
  if (closeM > openM) {
    inside = cur >= openM && cur < closeM;
  } else {
    inside = cur >= openM || cur < closeM;
  }

  if (!inside) {
    return {
      accepting: false,
      reason: 'outside_hours',
      message: 'This store is outside its opening hours.',
    };
  }

  return { accepting: true, reason: null, message: '' };
}

/** @deprecated internal — exported for tests */
export function _testNormalizeOperatingHours(oh) {
  return buildDayMapFromOperatingHours(oh);
}

export function enrichStoreForCustomerListing(store, now = new Date()) {
  const { accepting, reason, message } = getStoreOrderEligibility(store, now);
  return {
    ...store,
    is_open_now: accepting,
    closed_reason: accepting ? null : reason,
    closed_message: accepting ? null : message,
  };
}

export function assertStoreAcceptingOrders(store, now = new Date()) {
  const el = getStoreOrderEligibility(store, now);
  if (el.accepting) return { ok: true };
  return {
    ok: false,
    status: 403,
    body: {
      error: 'STORE_CLOSED',
      code: 'STORE_CLOSED',
      details: el.message || 'This store is closed.',
      reason: el.reason,
    },
  };
}
