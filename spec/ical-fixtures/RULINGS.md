# Rulings — recurrence corpus

E15-R03 requires a **written ruling** for every accepted disagreement between the two
engines that expand `spec/ical-fixtures/rrule/`, so that a real disagreement is never
silently normalised away and never greened by weakening a fixture. A ruling cites the
RFC 5545 section that settles it and names the engine that is right.

Who expands what, and why both are in the comparison:

- **`icaljs`** — `ical.js` 2.2.1 in `server/api` (`server/api/test/recurrence-corpus.mjs`).
  It is the API's single recurrence authority (`docs/02` § Recurrence), so a wrong
  expansion here is a wrong occurrence in our own clients and in every recurring-event
  edit.
- **`vobject`** — `sabre/vobject` 4.6.1 in `server/caldav`
  (`server/caldav/tests/RecurrenceCorpus.php`), reachable from
  `server/caldav/tests/corpus-cli.php`. SabreDAV answers `calendar-query` time-range
  filters with it and computes each stored object's first and last occurrence, so a
  wrong expansion here decides what a stock app's date-range query sees
  (`docs/05` risk 2, second paragraph).

Where `vobject` is wrong the fix is to correct the stored first and last occurrence or
to patch it upstream; we never fork it. Where `ical.js` is wrong the API reports wrong
occurrences and the fix is upstream (we do not hand-roll RRULE expansion either).

The machine-readable block below is the single source of truth. Both component suites
read it: a fixture whose golden disagrees with an engine is accepted **only** when the
matching ruling records exactly that first difference and names the other engine as
right, and a ruling whose deviation no longer exists fails those suites as well as
`make verify-corpus`. `infra/scripts/corpus-compare.mjs` checks the same block against
the two engines' real output.

Shape of one ruling:

- `fixture` — the fixture id (the `.ics` file without its extension);
- `firstDifference` — the first differing entry: `type` is `occurrences` or `overrides`,
  `index` is its position, and `icaljs` / `vobject` are that entry in each engine's
  normalised form (`null` when the engine stops earlier; an override is
  `<start>|<replaces>`);
- `rfc` — the RFC 5545 section that settles the disagreement;
- `correct` — the engine that expands the rule as the RFC requires;
- `note` — why it matters for the product and what the fix is.

```json
{
  "rulings": [
    {
      "fixture": "minutely-interval-90-count-4",
      "firstDifference": {
        "type": "occurrences",
        "index": 1,
        "icaljs": "20260102T103000Z",
        "vobject": "20260102T090000Z"
      },
      "rfc": "RFC 5545 § 3.8.5.3",
      "correct": "icaljs",
      "note": "The \"Every hour and a half for 4 occurrences\" example (09:00, 10:30, 12:00, 13:30): INTERVAL is a multiple of the FREQ unit, so 90 minutes must advance each instance by 90 minutes. sabre/vobject 4.6.1 emits DTSTART four times and drops every later instance, so a calendar-query time-range filter and the object's stored first/last occurrence are wrong for every sub-hourly rule. Fix upstream or correct the stored first and last occurrence; never fork."
    },
    {
      "fixture": "weekly-with-rdate",
      "firstDifference": {
        "type": "occurrences",
        "index": 1,
        "icaljs": "20260113T090000Z",
        "vobject": "20260201T090000Z"
      },
      "rfc": "RFC 5545 § 3.8.5.2",
      "correct": "icaljs",
      "note": "\"When they both appear in a recurring component, the recurrence instances are defined by the union of occurrences defined by both the RRULE and RDATE.\" sabre/vobject 4.6.1 returns only DTSTART and the RDATE value and drops the remaining RRULE instances, so one stored event with RDATE beside RRULE is under-reported to stock apps. Fix upstream or correct the stored first and last occurrence; never fork."
    },
    {
      "fixture": "yearly-byweekno-20-monday-count-5",
      "firstDifference": {
        "type": "occurrences",
        "index": 0,
        "icaljs": "20260518T090000Z",
        "vobject": "20260511T090000Z"
      },
      "rfc": "RFC 5545 § 3.8.5.3",
      "correct": "vobject",
      "note": "The \"Monday of week number 20 (where the default start of the week is Monday)\" example: BYWEEKNO counts ISO weeks, so the 2026 instance is Monday 2026-05-11, not the 20th Monday of the year (2026-05-18). ical.js 2.2.1 treats the BYWEEKNO value as the weekday ordinal and then continues weekly, so every instance of such a rule is wrong in the API — the recurrence authority for our own clients. Report upstream; do not hand-roll BYWEEKNO."
    },
    {
      "fixture": "yearly-leap-day-all-day",
      "firstDifference": {
        "type": "occurrences",
        "index": 0,
        "icaljs": "20260301",
        "vobject": "20280229"
      },
      "rfc": "RFC 5545 § 3.8.5.3",
      "correct": "vobject",
      "note": "The note after the § 3.8.5.3 examples: \"recurrence rules may generate recurrence instances with an invalid date (e.g., February 30) ... Such recurrence instances MUST be ignored and MUST NOT be counted as part of the recurrence set.\" A yearly rule whose DTSTART is 29 February therefore has no instance in a non-leap year. ical.js 2.2.1 rolls the invalid date forward to 1 March and counts it, which would place an all-day event on the wrong day in the API; sabre/vobject skips it. Report upstream; neither engine may be patched in this repository."
    }
  ]
}
```
