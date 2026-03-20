/**
 * Store operating hours → whether customers can order right now.
 * Uses IANA timezone (default Africa/Harare) and per-day { open, close } in 24h "HH:MM".
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

function parseTimeToMinutes(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return h * 60 + min;
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

function getDaySchedule(operatingHours, dayKey) {
  if (!operatingHours || typeof operatingHours !== 'object') return null;
  const direct = operatingHours[dayKey];
  if (direct && typeof direct === 'object') return direct;
  const ed = operatingHours.every_day;
  if (ed && typeof ed === 'object') return ed;
  return null;
}

function hasStructuredSchedule(oh) {
  if (!oh || typeof oh !== 'object') return false;
  if (oh.every_day && typeof oh.every_day === 'object') return true;
  return WEEKDAYS.some((d) => {
    const s = oh[d];
    return s && typeof s === 'object' && (s.open || s.close);
  });
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

  const oh = store.operating_hours;
  const tz =
    (oh && typeof oh === 'object' && oh.timezone && String(oh.timezone).trim()) || DEFAULT_TZ;

  if (!hasStructuredSchedule(oh)) {
    const accepting = store.is_open !== false;
    return {
      accepting,
      reason: accepting ? null : 'manual_closed',
      message: accepting ? '' : 'This store is closed right now.',
    };
  }

  const dayKey = getWeekdayKey(now, tz);
  const schedule = getDaySchedule(oh, dayKey);

  if (schedule && schedule.closed === true) {
    return {
      accepting: false,
      reason: 'outside_hours',
      message: 'This store is closed today.',
    };
  }

  const openStr = schedule?.open ?? oh.open;
  const closeStr = schedule?.close ?? oh.close;
  const openM = parseTimeToMinutes(openStr);
  const closeM = parseTimeToMinutes(closeStr);

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
    // Overnight window (e.g. 22:00–02:00)
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
