# Source — `valarm-triggers.ics`

- **Imitates:** the two alarms stock apps write: a `DISPLAY` alarm triggered relative to the event's end, and an `AUDIO` alarm with an absolute trigger, `REPEAT`/`DURATION` and an `ATTACH`.
- **Public document:** RFC 5545 § 3.6.6 (`VALARM`), § 3.8.6.1 (`ACTION`), § 3.8.6.3 (`TRIGGER`), § 3.2.14 (`RELATED`), § 3.8.6.2 (`REPEAT`), § 3.8.2.5 (`DURATION`) and § 3.8.1.1 (`ATTACH`). **Imitates the documented format, not a capture.**
- **Invented:** the UID, the offsets, the attachment URL (`example.test` is reserved for documentation) and the `PRODID` string.
