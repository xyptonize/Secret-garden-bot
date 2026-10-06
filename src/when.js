// Turning what somebody typed into a moment in time.
//
// Everything is interpreted in the server's own timezone, because "21:00" means
// nine in the evening here, not in UTC. Converting a wall clock reading to an
// instant needs the zone's offset *at that instant*, which is a chicken and egg
// problem — solved by guessing, measuring the offset at the guess, and
// correcting (twice, so a reading that lands on a daylight-saving change still
// settles).

/** The zone's offset from UTC at a given instant, in ms. */
function offsetAt(utcMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - utcMs;
}

/** A wall-clock reading in `timeZone` -> the instant it refers to. */
export function zonedTime({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) guess = Date.UTC(year, month - 1, day, hour, minute) - offsetAt(guess, timeZone);
  return guess;
}

/** Today's date in `timeZone`, as { year, month, day, hour, minute }. */
export function nowIn(timeZone, at = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, Number(p.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

// Longest unit first, or "m" swallows the start of "minutes" and leaves litter
// behind that the leftover check then rejects.
// Longest unit first, or "m" swallows the start of "minutes". The lookahead
// stops a unit running into a word while still allowing "1h30m", where a digit
// follows the unit and \b would not match.
const DURATION = /(\d+)\s*(years|year|y|months|month|mo|weeks|week|w|days|day|d|hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s)(?![a-z])/gi;
const UNIT_MS = {
  // Seconds and years are understood but not encouraged: knowing what they mean
  // is what lets the caller say "that's too soon" or "that's too far away"
  // instead of "I couldn't read that".
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000,
  w: 604800000, week: 604800000, weeks: 604800000,
  mo: 2592000000, month: 2592000000, months: 2592000000,
  y: 31536000000, year: 31536000000, years: 31536000000,
};

/**
 * Read a time out of free text. Returns { at, text } — the instant in ms and
 * how it was understood — or null.
 *
 * Accepts, in the server's timezone:
 *   30m · 2h · 1h30m · 3d · 2 weeks      a while from now
 *   21:00 · 9pm                          today, or tomorrow if that's past
 *   tomorrow 21:00                       the next day
 *   14/03 21:00 · 14.03 21:00            a day this year (or next, if past)
 *   2026-10-10 18:00                     an exact date
 */
export function parseWhen(input, timeZone, now = Date.now()) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;
  const today = nowIn(timeZone, now);

  // 2026-10-10 18:00
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t]+(\d{1,2}):(\d{2}))?$/.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi] = iso;
    const at = zonedTime({ year: +y, month: +mo, day: +d, hour: +(h ?? 9), minute: +(mi ?? 0) }, timeZone);
    return Number.isFinite(at) ? { at, kind: 'date' } : null;
  }

  // 14/03 21:00, 14.03, 14-03 9pm
  const dmy = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/.exec(text);
  if (dmy) {
    const [, d, mo, y, h, mi, ampm] = dmy;
    let hour = h == null ? 9 : +h;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    let year = y ? (y.length <= 2 ? 2000 + +y : +y) : today.year;
    let at = zonedTime({ year, month: +mo, day: +d, hour, minute: +(mi ?? 0) }, timeZone);
    if (!y && at <= now) at = zonedTime({ year: year + 1, month: +mo, day: +d, hour, minute: +(mi ?? 0) }, timeZone);
    return Number.isFinite(at) ? { at, kind: 'date' } : null;
  }

  // tomorrow 21:00 / today 9pm / 21:00 / 9pm
  const clock = /^(today|tomorrow|tmr)?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (clock && (clock[1] || clock[3] != null || clock[4] || /^\d{1,2}:\d{2}$/.test(text))) {
    const [, day, h, mi, ampm] = clock;
    let hour = +h;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour > 23) return null;
    const plus = day === 'tomorrow' || day === 'tmr' ? 1 : 0;
    let at = zonedTime({ year: today.year, month: today.month, day: today.day + plus, hour, minute: +(mi ?? 0) }, timeZone);
    // "21:00" when it's already 22:00 means tomorrow, unless they said today.
    if (at <= now && !day) at = zonedTime({ year: today.year, month: today.month, day: today.day + 1, hour, minute: +(mi ?? 0) }, timeZone);
    return Number.isFinite(at) ? { at, kind: 'clock' } : null;
  }

  // 30m, 1h30m, 2 days
  DURATION.lastIndex = 0;
  let total = 0;
  let matched = false;
  let rest = text.replace(/^in\s+/, '');
  for (const m of rest.matchAll(DURATION)) {
    total += Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
    matched = true;
  }
  // The whole thing has to be durations and nothing else. Being lenient here is
  // how "-5m" quietly became five minutes from now: the minus was simply
  // ignored, and a reminder was set for the opposite of what was asked.
  DURATION.lastIndex = 0;
  const leftover = rest.replace(DURATION, '').replace(/[\s,]+|\band\b/g, '');
  if (matched && total > 0 && leftover === '') {
    return { at: now + total, kind: 'in', ms: total };
  }
  return null;
}
