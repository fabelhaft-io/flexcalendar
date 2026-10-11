# Source — `private-valarm.ics`

- **Written by:** our own Private-calendar writer, not an imitation. The object is a
  Private skeleton in the sense of E03-R09 (the allow-list `Calflex\PrivateSkeleton`
  enforces), with exactly one `X-CALFLEX-ENVELOPE-SHA256` per `VEVENT`; there is
  therefore no upstream document to cite.
- **Behaviour exercised:** the one `VALARM` a Private skeleton keeps, with the fixed description `Reminder`.
- **Invented:** everything — the `UID` is a made-up UUIDv4, the times and dates are
  arbitrary, and the envelope hash is a synthetic placeholder, not the hash of a real
  envelope.
