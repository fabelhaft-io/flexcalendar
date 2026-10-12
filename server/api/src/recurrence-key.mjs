import ICAL from 'ical.js';
import { ZoneError, instantOf, resolves } from './zones.mjs';

/** `YYYYMMDDTHHMMSS`, the wall clock a `TZID` value is written as. */
const LOCAL = /^\d{8}T\d{6}$/;

/**
 * Canonical sidecar identity for an override: the `recurrence_id` column of
 * `public.event_envelopes`, the AAD's field 3, and the recurrence property the
 * skeleton spells (`spec/crypto.md` §5.2). The master uses `NULL`, not this
 * function.
 *
 * A `DATE` stays eight digits, and a `DATE-TIME` is **converted to UTC** and
 * written as an instant. The conversion is RFC 5545 § 3.3.5 form 3 through
 * `src/zones.mjs` (`instantOf`, i.e. ICU), never through `ical.js`: on the one
 * local time a spring-forward skips and the one an autumn overlap repeats,
 * `ical.js` gives the other answer (`spec/crypto.md` §3.4), and the key has to
 * be the instant a client sealed under.
 *
 * The zone comes from the property's own `TZID` parameter and ICU, **never**
 * from the document's `VTIMEZONE` or from ical.js's global `TimezoneService`:
 * a stock app often omits the definition, and registering a client's component
 * would be process-wide state one client could use to redefine `Europe/Berlin`
 * for every request (E04-R04). A floating time — no `Z`, no `TZID` — and a
 * `TZID` ICU cannot resolve are refused rather than assigned an envelope key
 * they do not have.
 *
 * @param {ICAL.Property} property
 * @returns {string}
 */
export function recurrenceKey(property) {
  if (
    !(property instanceof ICAL.Property) ||
    property.name !== 'recurrence-id'
  ) {
    throw new Error('Expected a RECURRENCE-ID property');
  }
  const value = property.getFirstValue();
  if (!(value instanceof ICAL.Time)) {
    throw new Error('RECURRENCE-ID must be DATE or DATE-TIME');
  }
  if (value.isDate) return value.toICALString();
  const local = value.toICALString();
  const tzid = property.getParameter('tzid');
  if (typeof tzid === 'string' && tzid !== '') {
    if (!resolves(tzid)) {
      throw new Error('RECURRENCE-ID requires UTC or a resolved TZID');
    }
    if (!LOCAL.test(local)) {
      throw new Error('RECURRENCE-ID requires a reading the zone resolves');
    }
    try {
      return instantOf(local, tzid);
    } catch (error) {
      if (error instanceof ZoneError) {
        throw new Error('RECURRENCE-ID requires a reading the zone resolves', {
          cause: error,
        });
      }
      throw error;
    }
  }
  // No `TZID`: a `Z` time names its instant by itself, and anything else is
  // floating — a local clock with no zone, which has no canonical instant.
  if (value.zone === ICAL.Timezone.utcTimezone || local.endsWith('Z')) {
    return local;
  }
  throw new Error('RECURRENCE-ID requires UTC or a resolved TZID');
}
