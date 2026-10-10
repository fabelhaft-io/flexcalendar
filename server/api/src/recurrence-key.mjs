import ICAL from 'ical.js';

/**
 * Canonical sidecar identity for an override. The master uses NULL, not this
 * function. TZID values must resolve through VTIMEZONE or ICAL.TimezoneService.
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
  // ical.js falls back to its floating zone for an unresolved TZID. Never
  // silently treat that local clock time as UTC and select the wrong envelope.
  if (value.zone === ICAL.Timezone.localTimezone) {
    throw new Error('RECURRENCE-ID requires UTC or a resolved TZID');
  }
  return value.convertToZone(ICAL.Timezone.utcTimezone).toICALString();
}
