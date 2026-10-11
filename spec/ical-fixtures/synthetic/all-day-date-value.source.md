# Source — `all-day-date-value.ics`

- **Imitates:** the all-day event a stock app writes when the user picks "all day": `DTSTART;VALUE=DATE` with an exclusive `DTEND;VALUE=DATE` and `TRANSP:TRANSPARENT`.
- **Public document:** RFC 5545 § 3.3.4 (the `DATE` value type), § 3.8.2.4 (`DTSTART`), § 3.8.2.2 (`DTEND`) and § 3.8.2.7 (`TRANSP`); INV-04 states the same rule for our own writes, which is what makes the distinction from a midnight-to-midnight date-time worth pinning. **Imitates the documented format, not a capture.**
- **Invented:** the UID, the dates and the `PRODID` string.
