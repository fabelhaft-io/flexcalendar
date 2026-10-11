# Source — `weekly-rrule-exdate.ics`

- **Imitates:** a weekly series as a stock app writes it: `FREQ=WEEKLY` with a `BYDAY` and a `COUNT` on the master and an `EXDATE;TZID=…` cancelling two instances, all in the event's own zone.
- **Public document:** RFC 5545 § 3.8.5.3 (`RRULE`), § 3.8.5.1 (`EXDATE`) and § 3.2.19 (`TZID`); the RFC's own weekly example is "Weekly on Tuesday and Thursday for five weeks". **Imitates the documented format, not a capture.**
- **Invented:** the UID, the dates and the `PRODID` version string.
