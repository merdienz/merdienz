const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 20000;

function parsePart(part, min, max, names) {
  const raw = part.toLowerCase();
  if (names && names[raw] !== undefined) return names[raw];
  if (!/^\d+$/.test(raw)) throw new Error(`invalid cron value: ${part}`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`cron value ${n} out of range ${min}-${max}`);
  return n;
}

export function parseCronField(field, min, max, names) {
  const values = new Set();
  const restricted = field.trim() !== '*';
  for (const chunk of field.split(',')) {
    const [rangePart, stepPart] = chunk.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: ${chunk}`);
    let start;
    let end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      start = parsePart(a, min, max, names);
      end = parsePart(b, min, max, names);
      if (end < start) throw new Error(`invalid cron range: ${chunk}`);
    } else {
      start = parsePart(rangePart, min, max, names);
      end = start;
    }
    for (let i = start; i <= end; i += step) values.add(i);
  }
  return { values, restricted };
}

export function parseCronExpr(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('cron_expr must have 5 fields (minute hour day month weekday)');
  }
  const [minute, hour, dom, month, dow] = parts;
  const dowField = parseCronField(dow, 0, 7, DOW_NAMES);
  if (dowField.values.has(7)) {
    dowField.values.add(0);
    dowField.values.delete(7);
  }
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dom: parseCronField(dom, 1, 31),
    month: parseCronField(month, 1, 12, MON_NAMES),
    dow: dowField,
  };
}

export function assertValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    throw new Error(`invalid timezone: ${timeZone}`);
  }
  return timeZone;
}

const formatters = new Map();

function formatter(timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

const DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date, timeZone) {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    dow: DOW_MAP[get('weekday')],
  };
}

export function timezoneOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  return asUtc - date.getTime();
}

export function instantsForLocal(timeZone, year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const probes = [new Date(guess - 36 * 3600000), new Date(guess), new Date(guess + 36 * 3600000)];
  const offsets = new Set(probes.map((d) => timezoneOffsetMs(d, timeZone)));
  const instants = [];
  for (const offset of offsets) {
    const date = new Date(guess - offset);
    const p = zonedParts(date, timeZone);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) {
      instants.push(date);
    }
  }
  instants.sort((a, b) => a.getTime() - b.getTime());
  const unique = [];
  for (const d of instants) {
    if (!unique.length || unique[unique.length - 1].getTime() !== d.getTime()) unique.push(d);
  }
  return unique;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekday(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function matchesDomDow(parsed, year, month, day) {
  const domOk = parsed.dom.values.has(day);
  const dowOk = parsed.dow.values.has(weekday(year, month, day));
  if (parsed.dom.restricted && parsed.dow.restricted) return domOk || dowOk;
  return domOk && dowOk;
}

function nextSorted(set, current, wrapMin) {
  const values = [...set].sort((a, b) => a - b);
  for (const v of values) {
    if (v >= current) return v;
  }
  return wrapMin == null ? null : values[0];
}

export function nextCronOccurrence(expr, timeZone, from = new Date()) {
  const parsed = parseCronExpr(expr);
  assertValidTimeZone(timeZone);
  const start = new Date(from.getTime() + 1);
  const limit = new Date(from.getTime() + FIVE_YEARS_MS);
  const startLocal = zonedParts(start, timeZone);
  let year = startLocal.year;
  let month = startLocal.month;
  let day = startLocal.day;
  let hour = startLocal.hour;
  let minute = startLocal.minute;
  let candidates = 0;

  while (candidates < MAX_CANDIDATES) {
    candidates += 1;
    if (!parsed.month.values.has(month)) {
      const next = nextSorted(parsed.month.values, month + 1, 1);
      if (next == null) break;
      if (next <= month) year += 1;
      month = next;
      day = 1;
      hour = 0;
      minute = 0;
      continue;
    }
    const dim = daysInMonth(year, month);
    if (day > dim) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
      day = 1;
      hour = 0;
      minute = 0;
      continue;
    }
    if (!matchesDomDow(parsed, year, month, day)) {
      day += 1;
      hour = 0;
      minute = 0;
      continue;
    }
    if (!parsed.hour.values.has(hour)) {
      const next = nextSorted(parsed.hour.values, hour + 1, 0);
      if (next == null) break;
      if (next <= hour) {
        day += 1;
        hour = next;
        minute = 0;
      } else {
        hour = next;
        minute = 0;
      }
      continue;
    }
    if (!parsed.minute.values.has(minute)) {
      const next = nextSorted(parsed.minute.values, minute + 1, 0);
      if (next == null) break;
      if (next <= minute) {
        hour += 1;
        minute = next;
      } else {
        minute = next;
      }
      continue;
    }

    const instants = instantsForLocal(timeZone, year, month, day, hour, minute);
    // Repeated wall-clock times fire once: use the earliest instant only.
    if (instants.length) {
      const first = instants[0];
      if (first.getTime() >= start.getTime()) {
        if (first.getTime() > limit.getTime()) {
          throw new Error('no cron occurrence in the next 5 years');
        }
        return first;
      }
    }

    minute += 1;
    if (minute > 59) {
      minute = 0;
      hour += 1;
    }
    if (hour > 23) {
      hour = 0;
      day += 1;
    }
  }
  throw new Error('no cron occurrence in the next 5 years');
}

export function minCronGapSeconds(expr, timeZone, from = new Date(), runs = 50) {
  const instants = [];
  let cursor = from;
  for (let i = 0; i < runs; i += 1) {
    try {
      const next = nextCronOccurrence(expr, timeZone, cursor);
      instants.push(next);
      cursor = next;
    } catch {
      // The 50-run walk can pass the 5-year search window (for example
      // 29 Feb crons past 2100). Keep any gaps already found.
      break;
    }
  }
  if (instants.length < 2) {
    const err = new Error('cron does not run often enough to measure an interval');
    err.statusCode = 400;
    err.code = 'BAD_CRON';
    throw err;
  }
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < instants.length; i += 1) {
    const gap = (instants[i].getTime() - instants[i - 1].getTime()) / 1000;
    if (gap < min) min = gap;
  }
  return min;
}

export function computeNextWindow(check, from = new Date()) {
  let expected;
  if (check.period_seconds != null) {
    expected = new Date(from.getTime() + Number(check.period_seconds) * 1000);
  } else if (check.cron_expr) {
    expected = nextCronOccurrence(check.cron_expr, check.timezone || 'UTC', from);
  } else {
    throw new Error('check has no schedule');
  }
  const graceUntil = new Date(expected.getTime() + Number(check.grace_seconds || 0) * 1000);
  return { expected_at: expected, grace_until: graceUntil };
}
