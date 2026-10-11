# Source — `recurrence-override.ics`

- **Imitates:** a stock app's override of one instance of a series: a second `VEVENT` with the same `UID`, a `RECURRENCE-ID` naming the instance it replaces with `RANGE=THISANDFUTURE`, a bumped `SEQUENCE`, and its own alarm.
- **Public document:** RFC 5545 § 3.8.4.4 (`RECURRENCE-ID`), § 3.2.13 (`RANGE`), § 3.8.7.4 (`SEQUENCE`) and § 3.6.6 (`VALARM`). **Imitates the documented format, not a capture.**
- **Invented:** the UID, the dates, the sequence number and the `PRODID` version string.
