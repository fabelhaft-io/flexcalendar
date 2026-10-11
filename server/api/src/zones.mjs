// --- E05-R09: time zones -----------------------------------------------------
//
// The API's one zone source is **Node's own zone database (ICU, through
// `Intl.DateTimeFormat`)** — no new dependency, and nothing is ever registered
// in `ical.js`'s global `TimezoneService`, because one client could then
// redefine `Europe/Berlin` for every request in the process (E04-R04's note).
// `ical.js` carries no zone database and is wrong on two single local times
// (`spec/ical-fixtures/dst/README.md`), so **no instant this API computes comes
// out of `ical.js`**: `instantOf` below is the RFC 5545 § 3.3.5 form 3 reader,
// and the `VTIMEZONE` the API embeds is generated from ICU as well.
//
// What the four functions are:
//
//   * `isIanaZone(name)` — what a **write** may name: an IANA zone, in its exact
//     IANA spelling, that ICU resolves. Case matters: ICU accepts any spelling
//     (`europe/berlin`) and canonicalises it, so `src/iana-zones.mjs` carries the
//     597 IANA names and this is the exact-case check. Link names are IANA names
//     too — `Asia/Kolkata`, `US/Eastern`, `Asia/Calcutta` are accepted. A Windows
//     name (`W. Europe Standard Time`), an unknown one (`Mars/Olympus`), the
//     empty string and anything with spaces or control characters are not.
//   * `resolves(name)` — whether ICU can read the name at all, which is what a
//     **read** of a stored `TZID` asks: a time in a zone the resolver cannot
//     resolve is reported as its wall clock and its `TZID` and nothing else (the
//     Windows fixture of E15-R01 is read that way, INV-02).
//   * `instantOf(local, tzid)` — RFC 5545 § 3.3.5 form 3, from ICU's offsets: a
//     reading that occurs twice is the **first** occurrence, one that does not
//     occur is read with the offset **before** the gap. This is the only place
//     the API turns a wall clock into an instant, and the DST table of E15-R02
//     (`spec/ical-fixtures/dst/cases.json`) is its contract.
//   * `localOf(instant, tzid)` — the other direction, for a viewer's wall clock.
//   * `vtimezoneFor(tzid, {from, to})` — the `VTIMEZONE` text an object embeds so
//     that a client without a zone database reads the same instants this module
//     does. See below.
//
// **The generated `VTIMEZONE` spells out ICU's real transitions as `RDATE`s**,
// inside the property allow-list the E03-R09 write guard enforces (`TZID`,
// `X-LIC-LOCATION`; `DTSTART`, `TZOFFSETFROM`, `TZOFFSETTO`, `RDATE` in an
// observance — no `RRULE`, no `TZNAME`, no `TZURL`). One observance is emitted
// per distinct `(TZOFFSETFROM, TZOFFSETTO)` pair, so every transition's offsets
// are spelled out rather than inferred, and a zone whose standard offset changed
// once (Europe/Moscow 2011, say) is as exact as a DST zone. The observance's
// `DTSTART`/`RDATE` values are local times in the transition's **from** offset,
// which is the convention RFC 5545 § 3.6.5's own example uses and what
// `ical.js` expects. A leading observance at `from` pins the offset in force
// then, so every instant in `[from, to)` resolves — including the ones before
// the first real transition.
//
// The price is size: with the API's own horizon (1970-01-01 to 2101-01-01) a
// DST zone carries one `RDATE` per transition, so `Europe/Berlin` is 246 value
// lines (5.9 KB) of the stored object — see `HORIZON` and `test/zones.test.mjs`,
// which pins the count for Berlin and bounds every zone. `docs/05` risk 3 owns
// the alternative (an `RRULE` per
// observance, which is smaller but re-expands through a library that is wrong on
// two single local times); it is raised as an open question with this
// requirement rather than chosen here.
//
// Refusals are `ZoneError`s, and a message never carries a name or a value:
// `kind` is `unknown-zone`, `invalid-local`, `invalid-instant` or
// `invalid-window`.

import { IANA_ZONES } from './iana-zones.mjs';

/**
 * The window the API's own `VTIMEZONE`s cover: every transition ICU reports in
 * `[from, to)`. An event the API can write lives inside it — 1970 is before any
 * calendar this product accepts, and a daily event with no end reaches 2100 and
 * stops there (E05-R05 owns the expansion horizon) — and a stored `TZID` time
 * outside it still reads as its wall clock, exactly as INV-02 asks.
 */
export const HORIZON = Object.freeze({ from: '1970-01-01', to: '2101-01-01' });

/** `YYYYMMDDTHHMMSS`, the wall clock RFC 5545 writes without a `Z`. */
const LOCAL = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
/** `YYYYMMDDTHHMMSSZ`, a UTC instant. */
const INSTANT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
/** `YYYY-MM-DD`, the form a caller passes a window bound in. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A refusal from this module. `kind` is one fixed word; the message is it. */
export class ZoneError extends Error {
  /** @param {string} kind */
  constructor(kind) {
    super(`time zone ${kind}`);
    this.name = 'ZoneError';
    this.kind = kind;
  }
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const FORMATTERS = new Map();
/**
 * The names ICU has resolved so far. Only the positive answer is remembered:
 * a name is either one of the finitely many ICU knows or it is not, and a
 * refusal is decided per call rather than cached, so the cache cannot grow with
 * whatever a client sends (the refusals a client can provoke are the cheap path).
 * @type {Set<string>}
 */
const RESOLVABLE = new Set();
/** @type {Map<string, string>} */
const ZONES = new Map();

/**
 * The formatter one zone is read through: the host-independent field list the
 * DST table's own oracle uses (`infra/scripts/dst-table.mjs`), so both agree by
 * construction.
 * @param {string} tzid
 * @returns {Intl.DateTimeFormat}
 */
function formatter(tzid) {
  let found = FORMATTERS.get(tzid);
  if (found === undefined) {
    found = new Intl.DateTimeFormat('en-CA', {
      timeZone: tzid,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(tzid, found);
  }
  return found;
}

/**
 * Whether ICU can read the name at all — any spelling it knows, which is what a
 * stored `TZID` is read with. A name ICU refuses has no offsets to compute.
 * @param {unknown} tzid
 * @returns {boolean}
 */
export function resolves(tzid) {
  if (typeof tzid !== 'string' || tzid === '') return false;
  if (RESOLVABLE.has(tzid)) return true;
  try {
    formatter(tzid);
  } catch {
    return false;
  }
  RESOLVABLE.add(tzid);
  return true;
}

/**
 * Whether a **write** may name this zone: an IANA name in its exact spelling
 * that ICU resolves. The spelling check is what makes `europe/berlin` a 422
 * while `Europe/Berlin`, `Asia/Kolkata` and `US/Eastern` are accepted.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isIanaZone(name) {
  return typeof name === 'string' && IANA_ZONES.has(name) && resolves(name);
}

/**
 * Epoch seconds from wall-clock fields, or null when they are not a reading that
 * exists — a month 13, a 30 February, an hour 24. `Date.UTC` rolls an impossible
 * date forward, so the fields have to come back out of a `Date` as they went in.
 * @param {number} year @param {number} month @param {number} day
 * @param {number} hour @param {number} minute @param {number} second
 * @returns {number | null}
 */
function epochOf(year, month, day, hour, minute, second) {
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    month < 1 ||
    month > 12 ||
    day < 1
  ) {
    return null;
  }
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(milliseconds);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return milliseconds / 1000;
}

/** @param {number} epochSeconds @returns {string} `YYYYMMDDTHHMMSSZ` */
function instantString(epochSeconds) {
  return `${new Date(epochSeconds * 1000).toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`;
}

/**
 * The zone's wall clock at a UTC instant, as the epoch seconds the same reading
 * would have as a UTC time. `Intl` never answers 24 as an hour here: `h23` is
 * pinned above.
 * @param {string} tzid @param {number} epochSeconds
 * @returns {number}
 */
function localEpoch(tzid, epochSeconds) {
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of formatter(tzid).formatToParts(
    new Date(epochSeconds * 1000),
  )) {
    parts[part.type] = part.value;
  }
  const seconds = epochOf(
    Number(parts.year),
    Number(parts.month),
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  if (seconds === null) throw new ZoneError('unknown-zone');
  return seconds;
}

/**
 * The zone's offset in seconds at a UTC instant.
 * @param {string} tzid @param {number} epochSeconds
 * @returns {number}
 */
function offsetOf(tzid, epochSeconds) {
  return localEpoch(tzid, epochSeconds) - epochSeconds;
}

/**
 * RFC 5545 § 3.3.5 form 3: the instant a wall-clock reading names, from ICU's
 * offsets. A reading that occurs twice is the first occurrence; one that does
 * not occur is read with the offset before the gap.
 * @param {string} local `YYYYMMDDTHHMMSS`
 * @param {string} tzid
 * @returns {string} `YYYYMMDDTHHMMSSZ`
 */
export function instantOf(local, tzid) {
  const match = typeof local === 'string' ? LOCAL.exec(local) : null;
  if (!match) throw new ZoneError('invalid-local');
  const reading = epochOf(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  if (reading === null) throw new ZoneError('invalid-local');
  if (!resolves(tzid)) throw new ZoneError('unknown-zone');
  // The offsets in force within a couple of days of the reading, which is every
  // offset the transition can be between: the reading sits at most one offset
  // away from its own instant, and an offset is at most a few hours.
  /** @type {Set<number>} */
  const offsets = new Set();
  for (const days of [-2, -1, 0, 1, 2]) {
    offsets.add(offsetOf(tzid, reading + days * 86400));
  }
  /** @type {number[]} */
  const candidates = [];
  for (const offset of offsets) {
    const candidate = reading - offset;
    // A `Time` is stored to the second; ICU's own answer for the instant the
    // candidate names is what tells a real occurrence from a gap.
    if (
      localEpoch(tzid, candidate) === reading &&
      !candidates.includes(candidate)
    ) {
      candidates.push(candidate);
    }
  }
  candidates.sort((left, right) => left - right);
  if (candidates.length > 0) {
    // Two candidates are the repeated hour; the first occurrence is the smaller
    // instant, which is the one with the larger offset.
    return instantString(candidates[0]);
  }
  return instantString(reading - Math.min(...offsets));
}

/**
 * The wall clock a viewer in `tzid` reads for an instant.
 * @param {string} instant `YYYYMMDDTHHMMSSZ`
 * @param {string} tzid
 * @returns {string} `YYYYMMDDTHHMMSS`
 */
export function localOf(instant, tzid) {
  const match = typeof instant === 'string' ? INSTANT.exec(instant) : null;
  if (!match) throw new ZoneError('invalid-instant');
  const seconds = epochOf(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  if (seconds === null) throw new ZoneError('invalid-instant');
  if (!resolves(tzid)) throw new ZoneError('unknown-zone');
  return instantString(localEpoch(tzid, seconds)).slice(0, -1);
}

/** @param {unknown} value @param {string} kind @returns {number} */
function dateEpoch(value, kind) {
  const match = typeof value === 'string' ? DATE.exec(value) : null;
  if (!match) throw new ZoneError(kind);
  const seconds = epochOf(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    0,
    0,
    0,
  );
  if (seconds === null) throw new ZoneError(kind);
  return seconds;
}

/**
 * A `VTIMEZONE` for a zone, as iCalendar text (`CRLF`-separated, no folding:
 * every line is short), covering every transition ICU reports in `[from, to)`.
 *
 * The text is what `src/ical-rmw.mjs` embeds in an object it writes, and what
 * `test/zones.test.mjs` parses with `ical.js` to hold the generated zone against
 * `instantOf`.
 *
 * @param {string} tzid
 * @param {{from: string, to: string}} window `YYYY-MM-DD`, `from` inclusive and `to` exclusive
 * @returns {string}
 */
export function vtimezoneFor(tzid, window) {
  if (!isIanaZone(tzid)) throw new ZoneError('unknown-zone');
  const from = window?.from;
  const to = window?.to;
  const start = dateEpoch(from, 'invalid-window');
  const end = dateEpoch(to, 'invalid-window');
  if (end <= start) throw new ZoneError('invalid-window');
  const key = `${tzid}|${from}|${to}`;
  let text = ZONES.get(key);
  if (text === undefined) {
    text = buildVtimezone(tzid, start, end);
    ZONES.set(key, text);
  }
  return text;
}

/**
 * One offset change in the window, bisected to the second.
 * @typedef {{at: number, from: number, to: number}} Transition
 */

/**
 * Every transition of the zone inside `[start, end)`, scanned a day at a time
 * and bisected within the day the offset moves in — a day's worth of readings is
 * 17 ICU calls rather than 86 400, and the scan continues from the transition it
 * finds, so a zone that moves twice inside one day reports both.
 * @param {string} tzid @param {number} start @param {number} end
 * @returns {Transition[]}
 */
function transitionsIn(tzid, start, end) {
  /** @type {Transition[]} */
  const found = [];
  let at = start;
  let current = offsetOf(tzid, at);
  while (at < end) {
    const day = at + 86400;
    if (offsetOf(tzid, day) === current) {
      at = day;
      continue;
    }
    let low = at;
    let high = day;
    while (high - low > 1) {
      const middle = low + Math.floor((high - low) / 2);
      if (offsetOf(tzid, middle) === current) low = middle;
      else high = middle;
    }
    const before = current;
    at = high;
    current = offsetOf(tzid, at);
    found.push({ at, from: before, to: current });
  }
  return found;
}

/**
 * `+0100`, `-0430` or `-004430`: RFC 5545 § 3.3.14's `utc-offset`.
 * @param {number} seconds
 * @returns {string}
 */
function offsetString(seconds) {
  const sign = seconds < 0 ? '-' : '+';
  const total = Math.abs(seconds);
  const hours = String(Math.floor(total / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const rest = total % 60;
  const tail = rest === 0 ? '' : String(rest).padStart(2, '0');
  return `${sign}${hours}${minutes}${tail}`;
}

/**
 * The generated text. One observance per distinct offset pair, plus the one that
 * pins the offset in force at the window's start; every observance's `DTSTART`
 * and `RDATE`s are the local readings of its transitions in its own
 * `TZOFFSETFROM`, as RFC 5545 § 3.6.5's example spells them.
 * @param {string} tzid @param {number} start @param {number} end
 * @returns {string}
 */
function buildVtimezone(tzid, start, end) {
  /** @type {Map<string, {name: string, from: number, to: number, times: number[]}>} */
  const observances = new Map();
  const offset = offsetOf(tzid, start);
  observances.set(`${offset}|${offset}`, {
    name: 'STANDARD',
    from: offset,
    to: offset,
    times: [start],
  });
  for (const transition of transitionsIn(tzid, start, end)) {
    const key = `${transition.from}|${transition.to}`;
    const found = observances.get(key);
    // The same pair of offsets is one observance however often it repeats; a
    // different pair is its own, so no reader has to infer an offset.
    if (found === undefined) {
      observances.set(key, {
        name: transition.to > transition.from ? 'DAYLIGHT' : 'STANDARD',
        from: transition.from,
        to: transition.to,
        times: [transition.at],
      });
    } else {
      found.times.push(transition.at);
    }
  }
  /** @type {string[]} */
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tzid}`, `X-LIC-LOCATION:${tzid}`];
  for (const observance of observances.values()) {
    lines.push(`BEGIN:${observance.name}`);
    lines.push(
      `DTSTART:${instantString(observance.times[0] + observance.from).slice(0, -1)}`,
    );
    lines.push(`TZOFFSETFROM:${offsetString(observance.from)}`);
    lines.push(`TZOFFSETTO:${offsetString(observance.to)}`);
    for (const time of observance.times) {
      // `ical.js` reads the `DTSTART` of an observance only when it carries no
      // `RDATE` at all, so every transition is an `RDATE`, the first included.
      lines.push(`RDATE:${instantString(time + observance.from).slice(0, -1)}`);
    }
    lines.push(`END:${observance.name}`);
  }
  lines.push('END:VTIMEZONE');
  return `${lines.join('\r\n')}\r\n`;
}
