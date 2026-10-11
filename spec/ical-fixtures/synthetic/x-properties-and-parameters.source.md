# Source — `x-properties-and-parameters.ics`

- **Imitates:** a Thunderbird/Lightning writer (`X-MOZ-GENERATION`, `X-MOZ-LASTACK`, `X-MOZ-SNOOZE-TIME`, each with an `X-` parameter of Mozilla's where it uses one) on an event that also carries the iTIP fields `ORGANIZER` and `ATTENDEE` with their standard parameters, and a quoted `X-` parameter value containing a colon, a semicolon and a comma.
- **Public document:** RFC 5545 § 3.8.4.1 (`ATTENDEE`), § 3.8.4.3 (`ORGANIZER`), § 3.8.1.2 (`CATEGORIES`), the parameter sections § 3.2.2 (`CN`), § 3.2.3 (`CUTYPE`), § 3.2.12 (`PARTSTAT`), § 3.2.16 (`ROLE`) and § 3.2.17 (`RSVP`), and the `X-` namespace of § 3.8.8.2 with the parameter ABNF of § 3.1. The `X-MOZ-*` names are Mozilla's and are specified by no RFC; **imitates the documented format, not a capture**.
- **Invented:** the UID, both addresses (`example.test` is reserved for documentation, so no real mailbox is named), the attendee and organizer names, and every `X-` value.
