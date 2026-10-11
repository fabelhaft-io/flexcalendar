# Source — `private-weekly-exdate-override.ics`

- **Written by:** hand-written to the Private skeleton that `adr/0001` § Private calendars
  and the E03-R09 allow-list define — no writer produces one yet, and it is not an imitation of
  another client. `Calflex\PrivateSkeleton` enforces the allow-list, with exactly one
  `X-CALFLEX-ENVELOPE-SHA256` per `VEVENT`; there is therefore no upstream document to cite.
- **Behaviour exercised:** a weekly master with an `EXDATE` and an override `VEVENT` with a `RECURRENCE-ID` — two `VEVENT`s in one object, so the skeleton's one-hash-per-`VEVENT` rule is exercised twice.
- **Invented:** everything — the `UID` is a made-up UUIDv4, the times and dates are
  arbitrary, and the envelope hash is a synthetic placeholder, not the hash of a real
  envelope.
