# ADR 0001 — Calendar privacy modes

- **Status**: Accepted
- **Date**: 2026-09-27
- **Amended by**: [ADR 0003](0003-android-first-private-first-delivery.md) (delivery order, recovery before open signup, key derivation); pinned decisions D-06–D-08, D-14, D-15, D-17 (2026-10-04) and D-18 (2026-10-05) from `06`; the owner's ruling of 2026-10-12 on `UID` values; the owner's acceptance of the wire spec `spec/crypto.md` (E12-R01), 2026-10-12. See § Amendments.
- **Relates to**: [`00-overview.md`](../00-overview.md) (central constraint), [`01-architecture.md`](../01-architecture.md) (sharing model), [`03-native-calendar-integration.md`](../03-native-calendar-integration.md), [`04-implementation-phases.md`](../04-implementation-phases.md) (Phase 5), [`05-risks-and-open-questions.md`](../05-risks-and-open-questions.md) (closes the E2EE open question)

## Context

**The requirement is a marketing claim, not a threat model**: *"it's safe — we cannot see your calendar content without you knowing."* There is no specific adversary and no compliance regime forcing it. That does not make it soft: because the claim is the product, it must be literally true and defensible. Encryption at rest with server-held keys does not qualify, and the claim has to be scoped to exactly what is true, per calendar, and visible in the UI.

**Encryption and stock-app editing cannot coexist on the same calendar.** CalDAV assumes the server can read event data. A participant who installs nothing can never hold a key, so serving them readable iCalendar requires the server to hold plaintext. Nothing engineers this away: there is no iCalendar encryption standard and none in progress — IETF CALEXT's active work is JSCalendar conversion, property dependencies, relations and event publishing — and no stock calendar app will ever decrypt anything without our code on the device.

Prior art divides on exactly this line:

| Product | E2EE | Stock-app write |
|---|---|---|
| Proton Calendar, Tuta | Yes | **No** — own apps only, inbound `.ics` subscription at best |
| EteSync / SilentSuite | Yes | Yes, **except iOS** — a local bridge decrypts on-device and serves CalDAV to localhost, which iOS cannot host |

**The privacy need and the interop need peak on different calendars.** A personal health calendar is highly sensitive and has no interop problem — it is only you, and you have the app on your own devices. A family calendar shared across Apple Calendar, our Android app and the Google Calendar app needs interop and is only mildly sensitive. That observation is what this ADR is built on.

### Hard and negotiable requirements

| Requirement | Status |
|---|---|
| Editable in stock calendar apps on iPhone, Samsung and Pixel (`00-overview.md` #2) | **Hard**, satisfied by the Shared mode rather than by every calendar |
| iOS *and* Android stock-app support | **Hard** — no design may serve one and not the other |
| Near-real-time sharing between users (#3) | **Hard** for Shared; Private is near-real-time between our own clients |
| The privacy claim must be literally true | **Hard** — it is the product |
| We host the instance; users do not self-host | **Hard** — self-hosting is not available as the privacy story |
| Every calendar is encrypted | **Negotiable, and negotiated away** — the constraint this ADR relaxes |

### Effect on the CalDAV-is-source-of-truth rule

The rule survives with its justification narrowed. CLAUDE.md makes CalDAV non-negotiable *because* of requirement #2, and that reasoning now applies to Shared and Published calendars only. A Private calendar has no third-party readers, so the protocol argument does not force CalDAV there.

We keep CalDAV as the store for all modes anyway, for practical reasons: one storage engine, one sync mechanism (WebDAV-Sync `sync-token`), one data model, and mode switching as a metadata change rather than a migration. Stock-app round-tripping is unaffected, since the only calendars stock apps see are Shared and Published, both plaintext iCalendar exactly as `00`–`05` describe.

## Decision

**Privacy is a per-calendar mode, chosen explicitly when the calendar is created and switchable afterwards. There is no default** — the choice is presented as a constraint on who can participate, not as a feature toggle.

| | **Private** | **Shared** | **Published** |
|---|---|---|---|
| Encryption | E2EE; server cannot read content | None; server reads everything | None, or busy-only from a Private calendar |
| Clients | Our apps only | Any CalDAV client, including stock apps | Anything that subscribes to `.ics` |
| Editing | Yes, in our apps | Yes, everywhere | No, read-only |
| Requires our app | Yes, on every device | No | No |
| Typical use | Health, therapy, interviews, co-parenting | Family weekends, school, teams | A grandparent's iPhone, a public team feed |

**Recovery posture is a separate, account-level setting**, because escrow wraps the user's key rather than any one calendar. It applies to every Private calendar that user can read.

### Private calendars — cryptography

*Amended 2026-10-04 (D-15, D-17): no key derives from the login password, and every user also has an Ed25519 identity key.*

```
  device linking                     recovery code              escrow key in HSM-backed KMS
  (QR + short code, from a           (shown once)               (Tier 1, from Phase 7)
   device that holds the keys)            |                               |
        |                               HKDF                              |
  crypto_box_seal to the new              |                               |
  device's ephemeral X25519 key           v                               |
        |                              KEK_rc                             |
        +----------------------+----------+-------------------------------+
                               |
                 each independently delivers or unwraps
                               v
      user X25519 private key + Ed25519 identity key    <-- held on the device (Keystore / Keychain);
                               |                            server stores only wrapped copies
                      crypto_box_seal_open                  (kinds: recovery_code, escrow)
                               v
              CCK[calendar, epoch]  (32 bytes)          <-- one sealed copy per member, signed
                               |                            with the sender's identity key
                XChaCha20-Poly1305 open
                               v
                    event content plaintext
```

The login password is absent on purpose. It is typed into our own IdP, so a key derived from it would be derivable by us, and the Tier 2 claim would be false (D-17). It authenticates and nothing else.

- **AEAD**: XChaCha20-Poly1305, one envelope per event over a canonical JSON payload using **JSCalendar (RFC 8984) field names** — the same information as iCalendar, and it keeps the JMAP path open.
- **AAD**: `"calflex-v1" || calendar_id || UID || RECURRENCE-ID || epoch || canonical(DTSTART, DTEND, RRULE)`, each field length-prefixed as `spec/crypto.md` defines. Binding the cleartext skeleton makes server-side tampering with timing detectable, and it is safe here precisely because no stock app ever edits a Private calendar. *Amended (D-14):* `calendar_id` and `RECURRENCE-ID` were added, so the server can't move an envelope onto another override of the same event or into another calendar. *Amended (2026-10-12, wire spec):* the canonical timing fields bind a zoned time as its `TZID` and local wall clock, a `Z` time as the UTC instant written in the skeleton and an all-day event as its date, never an instant a zone database computes, so a tzdata update cannot make stored envelopes unreadable (`spec/crypto.md` §3.5). `RDATE` and `EXDATE` are not bound: the API writes `EXDATE` (INV-05), and binding it would invalidate the master's envelope for a change its content did not make (§2.6).
- **Skeleton contents** *(D-08)*: `UID`, `DTSTART`/`DTEND`, `RRULE`/`RDATE`/`EXDATE`, `RECURRENCE-ID`, `SEQUENCE`, `VALARM` and `X-CALFLEX-ENVELOPE-SHA256`. Everything else is in the envelope, including `ATTENDEE` and `ORGANIZER`, so Private calendars have no email invites. `VALARM` is cleartext, so our clients always write a fixed `DESCRIPTION:Reminder` and never the event title. *Amended (2026-10-05):* the structural properties RFC 5545 requires or allows in their place (`DTSTAMP`, `DURATION` instead of `DTEND`, `CREATED`, `LAST-MODIFIED`, and `VTIMEZONE` components) are part of the skeleton too. The exhaustive allow-list that the server enforces is in E03-R09. *Amended (2026-10-12):* the allow-list checks names, not free-text values, and of those the `UID` is the one that travels (the object name, the outbox, the delta feed, URLs and logs, the sidecar key) and can never be changed, so the server also requires a lowercase UUIDv4 `UID`, on every `VEVENT` and `VALARM`, and the object name `<uid>.ics` when an object is **created** in a Private calendar (E03-R11). An update keeps the stored `UID`, so a Shared calendar switched to Private keeps its stock-app `UID`s, as INV-03 requires. The other free-text values (`PRODID`, `TZID`, `X-LIC-LOCATION`, `TZNAME`, `TZURL`) are written by the API from its own data and stay unchecked.
- **Calendar metadata** *(D-18)*: a Private calendar's name and colour are encrypted too. The client seals them under the CCK into a calendar-metadata envelope, which the server stores opaquely, and the CalDAV collection is named `Private calendar`. A calendar's name can say as much as an event title.
- **Key authenticity** *(D-15)*: sealed boxes don't authenticate the sender, and members' public keys are handed out by our server, which could substitute its own. Every user therefore has an Ed25519 identity key. Sealed CCK records and key bundles are signed with it, and members verify each other's identity keys in the app, by scanning a QR code in person or by comparing safety numbers. Key transparency can come later.
- **Key wrapping**: libsodium sealed boxes (`crypto_box_seal`, X25519). HPKE (RFC 9180) would be more modern but Dart has no maintained implementation. *Amended (2026-10-12, wire spec):* sealed boxes carry the CCK records and the device-link bundle. The private key's wrap under the recovery-code KEK is XChaCha20-Poly1305 with its own AAD label (`calflex-keywrap-v1`, binding the owner and the wrap kind), because that KEK is a symmetric HKDF output with no keypair to seal to (`spec/crypto.md` §6.3). Every key derivation is HKDF-SHA-256 (D-17), never `crypto_kdf`.
- **Rotation**: removing a member starts epoch N+1 for new writes. They keep whatever they already downloaded; no design prevents that.
- **Libraries**: `sodium_libs` (Flutter), `libsodium-wrappers` WASM (web), `lazysodium-android` (Kotlin, only if Phase 6 mirroring ships). *Amended (2026-10-12, E12-R02):* `sodium_libs` is discontinued and only re-exports `sodium`, so the Dart library depends on `sodium`, which builds libsodium itself; the web uses the standard `libsodium-wrappers` build plus WebCrypto's HKDF, which the library does not export (`docs/verification/crypto-libs-2026-10-12.md`). The API layer and CalDAV server link no crypto library for this purpose — a useful property to be able to state.

Envelope bytes, stored as one `bytea`:

```
 offset  size  contents
 ------  ----  --------------------------------------------
      0     1  envelope version (0x01)
      1     4  CCK epoch, big-endian uint32
      5    24  XChaCha20 nonce (random per write)
     29     n  ciphertext
   29+n    16  Poly1305 tag
```

*Amended (2026-10-12, wire spec):* an event envelope is at most 65,536 bytes, a ceiling the clients enforce; the API enforces only the calendar-metadata envelope's 4,096 (`spec/crypto.md` §1.1). The epoch is capped at 2,147,483,647, the range of the database's `integer` columns.

Sidecar table keyed `(calendar_id, uid, recurrence_id, envelope_sha256)`, written and read only by clients. `recurrence_id` is `NULL` for the master and set per override, because overrides are separate `VEVENT`s sharing a `UID` — get this wrong and an edited instance of a recurring event shows the master's title.

**Change detection** *(amended, D-06)*: an edit that only touches content would otherwise leave the `VEVENT`, its ETag and the sync-token unchanged, and no other client would see it. Every envelope write therefore also rewrites the skeleton with `X-CALFLEX-ENVELOPE-SHA256:<hash>`. The order is: insert the envelope row, then `PUT` the skeleton with `If-Match`, then garbage-collect the superseded row. Readers accept only an envelope whose hash matches the skeleton, so a crash between the steps leaves the previous version readable.

**Recurring edits** *(amended, D-07)*: "this and following" and similar edits rewrite skeleton fields that are bound into the AAD (for example `UNTIL` on the master), which would silently invalidate existing envelopes. On Private calendars these edits are therefore two-step. The API computes the resulting skeletons with `ical.js` and returns a plan. The client re-seals an envelope for every skeleton the plan changes, then commits the plan and the envelopes together with `If-Match`. Shared calendars keep the one-step intent.

### Recovery — escrowed by default, strict E2EE opt-in

**Tier 1, escrowed (default).** The private key is additionally wrapped to an escrow key in a cloud HSM. We *can* decrypt, so the guarantee is procedural rather than mathematical, and release requires all of: a user-initiated request; second-factor verification; notification to every registered device and email; a cancellable **72-hour delay**; and a user-readable append-only audit record.

This is what makes *"without you knowing"* true at this tier — not blindness, but unavoidable disclosure. The copy must say **"we can recover your calendar for you, and we will always tell you when we do"**, never "we cannot read it".

**Tier 2, strict (opt-in).** Destroys the escrow record, and requires at least one recovery method to exist first — Apple enforces the same precondition for Advanced Data Protection, for the same reason. In the order they work in practice:

1. **Recovery code.** 128 bits as a BIP39-style word list so it transcribes without error. Shown once, forced acknowledgement. The baseline; its weakness is that people lose it.
2. **Trusted contacts with a threshold.** A copy of the key wrapped to *n* family members' public keys under a k-of-n Shamir split (2-of-3), so no single contact can act alone. **The best fit for this product** — the social graph recovery needs already exists in the sharing model. Precedents: Apple's Recovery Contact, Bitwarden's Emergency Access.
3. **Passkey with the WebAuthn `prf` extension.** Derives a stable secret from a passkey the platform already syncs under its own E2EE, giving "recover with my Apple or Google account" while we hold nothing. Needs a native module (see ADR 0002).
4. **HSM-backed PIN vault.** The only safe way to protect a key with a short secret: an HSM enforces a hard attempt limit and destroys the record after N failures. Security comes from the hardware limit, not the PIN. Credibility requires destroying the HSM's admin credentials and publishing the design, as Apple did for its Cloud Key Vault and Signal does for SVR. Heavy; defer.

**Security questions are rejected outright.** A plaintext answer to "your first school" is low-entropy, frequently discoverable and often misremembered, and it would become the weakest link in the entire key hierarchy. Entropy must come from the recovery code or from a hardware-enforced attempt limit; there is no third source.

Tier 1 → Tier 2 is **not retroactive**: anything we held while escrowed, we could already read.

### Published feeds

Published calendars cannot be E2EE — a subscribing app reads plaintext, so "encrypted feed" can only mean TLS in transit plus an unguessable capability URL, which our server serves and therefore reads. Two variants:

- **Full detail, from a Shared calendar.** Real titles at a secret URL. Exposes nothing new, since a Shared calendar is already server-readable. This is the answer to *"share the family calendar with a grandparent who will never install an app"*.
- **Busy-only, from a Private calendar.** The client publishes free/busy blocks only: times, no content. The server learns nothing beyond the timing already in the skeleton, so the Private claim survives intact, and it is the only way a Private calendar reaches a keyless participant.

Feed URLs must be revocable and rotatable, since URL secrecy is the whole access control.

### Mode switching

| Transition | Rule |
|---|---|
| Shared → Private | Encrypts going forward. **Not retroactive** — that plaintext was already on our server and in our backups. Say so at the point of switching, not in a help page. |
| Private → Shared | Requires explicit owner confirmation and notification to every member, because it exposes their contributions to us. |
| Either direction | Logged and announced to members. A silent mode change would break the *"without you knowing"* half of the claim. |

### What we can and cannot claim

| | Can we read it? | Recovery if the user forgets everything | Honest claim |
|---|---|---|---|
| Shared / Published | Yes | Trivial | "Encrypted in transit and at rest" |
| Private, Tier 1 | Yes, via audited release | Yes, with notice and a cancellable delay | "We can recover it, and we always tell you" |
| Private, Tier 2 | **No** | **Data is lost** | "We cannot read it" |

Even at Tier 2, "zero knowledge" is not available: we still see the number of calendars and events, timing, recurrence, modification times and the share graph, but not calendar names (D-18). The overall story — *"private calendars are end-to-end encrypted; calendars that work with Apple and Google Calendar are not, and the app always tells you which is which"* — is honest because the mode is visible in the product.

## Consequences

- **Search is client-side only** on Private calendars, over the decrypted local cache. The API layer keeps auth, sync tokens, polling and push fan-out but cannot read content, so the "friendlier API for your own clients" in `01-architecture.md` is thinner there.
- **Rich change notifications are impossible** server-side for Private calendars; a push carries "calendar X changed" and the client resolves the detail. Already deferred in `04`.
- **No iTIP/iMIP invites and no Apple calendar-sharing extensions** on Private calendars — both need the server to read `ATTENDEE`, or to mediate a collection it cannot decrypt. Sharing lives in the API layer, which `01-architecture.md` already prefers.
- **Plaintext exists on every member's device**, in our app's cache. E2EE here means a blind server, not device confidentiality, and the copy must say so.
- **Encryption is Phase 5, not Phase 1, and it gates open signup.** The friends-and-family test group accepts plaintext shared history, and most such groups contain an Apple or Google Calendar user, so they run in Shared mode regardless. A stranger signing up does not accept it, and retrofitting leaves a plaintext history — so the deadline is the first user who did not knowingly choose plaintext, not a phase boundary.
- **Phase 1 reserves structure** so the reordering is safe: the `mode` column exists (accepting `shared` and `published` only at first), the sidecar table exists and stays empty, and `UID`s are random UUIDv4 from day one — a content-derived `UID` would leak titles retroactively and cannot be changed later without breaking every client's sync state.
- **Tier 1 escrow eases migration**: because we hold a wrapped key, promoting an existing plaintext calendar to Private can be done server-side. Tier 2 needs a client with keys online.
- **The Android sync adapter stays in Phase 4, scoped to Shared calendars.** DAVx⁵ holds no keys, so the "recommend DAVx⁵ for v1" guidance in `03-native-calendar-integration.md` remains correct for Shared and irrelevant for Private.
- **ADR 0002 (Flutter) stands**, with a revisit trigger recorded there.
- **Phase 0 is unchanged** and now understood to validate the Shared mode, which is the mode carrying requirement #2.

### Optional Phase 6 — mirroring Private calendars into the device calendar store

A Private calendar can be made visible in stock apps without weakening encryption: our app decrypts locally and writes plaintext into `EKCalendar` (iOS, EventKit) or `CalendarContract` (Android, extending the Phase 4 adapter). The server stays blind; the stock app reads a local mirror. Valuable for the personal-sensitive case, where the user owns every device. Gated on, in order:

1. **The `EKSource` spike.** The calendar must live in EventKit's *local* source so plaintext never leaves the device. A writable local source has historically been unreliable when iCloud Calendar is enabled; the iCloud source would upload plaintext titles to Apple and the subscribed source is read-only. **If this fails, iOS mirroring is dead** and the item is Android-only.
2. **Event identity** anchored in `EKCalendarItem.url` (`calflex://event/<uid>`), since `calendarItemExternalIdentifier` is read-only and `eventIdentifier` is not stable across edits. Shadow table on `eventIdentifier` as secondary index. Expect duplicate-event bugs here.
3. **Change detection** by shadow table plus windowed enumeration — `EKEventStoreChanged` carries no delta, deletions are visible only by full enumeration, and predicates cap at a four-year span.
4. **Reverse-direction latency.** No API wakes a suspended app, so an edit made in Apple Calendar reaches us in minutes to hours. Android has no such problem (`CalendarContract` has a `DIRTY` column). This is why the enhancement is optional rather than core.
5. **Recurrence fidelity.** `EKRecurrenceRule` is narrower than RFC 5545. Skeleton plus envelope is authority; EventKit is a projection, never read back as truth.

New disclosure if it ships: plaintext then sits in the OS calendar store and therefore in iCloud device backups, where Apple holds the keys unless Advanced Data Protection is on. The user can also drag an event out of our calendar into iCloud, which we see as a deletion and cannot prevent.

## Alternatives considered

- **Encrypt every calendar, with a padlock placeholder in stock apps.** **Rejected**: Apple Calendar shows `🔒 Private`, so the event is not viewable, and editing what you cannot identify is not editing. It collapses into a free/busy overlay while claiming stock-app support.
- **Encrypt every calendar, with user-chosen cleartext hints** ("Appointment", "Work"). **Rejected**: a family member holds the key and would still see only a hint in their own preferred app. That is a defective client, not a privacy trade-off.
- **Encrypted only, our apps only** (Proton's answer). **Rejected**: cannot serve a family whose members deliberately use different calendar apps.
- **Local decrypt bridge as the architecture** (EteSync model, CalDAV on localhost). **Rejected as a requirement**; retained as the optional Phase 6 mirroring. iOS cannot host the localhost bridge at all, so it needs the EventKit route regardless.
- **Per-user encryption at rest with keys in our KMS.** **Rejected**: we could still decrypt, so it does not support the claim that is the point of the requirement.
- **Exchange ActiveSync instead of CalDAV.** Natively supported by Apple Calendar and Samsung Calendar, with real push. **Rejected**: Microsoft-licensed protocol IP, substantially more complex, and Microsoft is narrowing its client surface (EAS 16.1 required for Exchange Online from March 2026).
- **No encryption at all.** Still correct if Private finds no users — Shared mode *is* this, so the downside is bounded and we can ship Shared first and learn.

## Open questions

1. ~~**Does a Private calendar keep a cleartext skeleton?**~~ **Answered (D-08): yes.** Recommended **yes** — `DTSTART`/`DTEND`/`RRULE` in the clear keeps one storage and sync engine across modes, makes switching a metadata change, enables CalDAV date-window queries, and makes the busy-only feed possible. Encrypting the timing too yields a stronger claim ("we know how many events you have, not when") at the cost of client-side-only windowing and a second sync path.
2. ~~**Is `ATTENDEE`/`ORGANIZER` encrypted on Private calendars?**~~ **Answered (D-08): encrypted, with no email invites on Private calendars.** Encrypting hides the social graph but kills invites.
3. **Which Tier 2 recovery methods ship first** beyond the recovery code. Trusted-contact threshold recovery is recommended as the second.
4. **Is the busy-only published feed in v1?** Neither Published variant is on the critical path.

## Amendments

### ADR 0003 — Android-first, Private-first delivery (2026-10-04)

- **Phase numbers in this ADR refer to the plan before ADR 0003.** The mapping is at the end of `04`.
- **Private mode ships first**, in the Android app at M1 (new Phase 3), instead of in old Phase 5. This supersedes the consequences "Encryption is Phase 5, not Phase 1" and "Phase 1 reserves structure". The `mode` check constraint allows only `private` until Phase 4 adds `shared` and `published`, and the envelope and key tables are in use from v1.
- **Recovery before open signup**: until Phase 7 every account is strict (Tier 2), with the recovery code as its mandatory recovery method plus device linking. When Tier 1 ships it becomes the default for new accounts. Existing accounts get it only as an explicit, logged choice.
### Pinned decisions from `06` (2026-10-04)

Applied in place above, each marked where it changes the text:

- **D-06**: the envelope hash in the skeleton, the sidecar key and the write order (§ Private calendars — cryptography).
- **D-07**: two-step recurring edits on Private calendars.
- **D-08**: open questions 1 and 2 are answered, and the skeleton contents are listed, including the fixed `VALARM` description.
- **D-14**: `calendar_id` and `RECURRENCE-ID` are in the AAD.
- **D-15**: Ed25519 identity keys, signed CCK records and in-app key verification.
- **D-17**: no KEK from the login password. `KEK_pw` and Argon2id are gone from the key diagram, and keys reach new devices by device linking, the recovery code or (Tier 1) escrow.

### Pinned decisions from `06` (2026-10-05)

- **D-18**: a Private calendar's name and colour are sealed under the CCK, and the server sees only `Private calendar` (§ Private calendars — cryptography). The skeleton list now names the structural properties that RFC 5545 requires.

### Owner's ruling (2026-10-12)

- **`UID` values on Private calendars**: a create in a Private calendar needs a lowercase UUIDv4 `UID` and the object name `<uid>.ics`, and an `RRULE` takes no `X-` rule part (§ Private calendars — cryptography, skeleton contents; E03-R09's table; E03-R11). It closes the leak E03-R09's second review found: the allow-list does not inspect values, so `UID:Chemo with Dr Smith` would be stored and copied into every index that names the object.

### The wire spec, accepted by the owner (2026-10-12)

`spec/crypto.md` (E12-R01) defines every byte of the formats above. Accepting it amends this ADR in four places, each marked above:

- **The AAD's timing fields** bind `TZID` and wall clock, not the UTC instant; `RDATE` and `EXDATE` are not bound.
- **The recovery-code wrap** is an AEAD under the HKDF KEK, not a sealed box; sealed boxes stay for CCK records and device linking.
- **The event-envelope ceiling** (65,536 bytes) is enforced by the clients only.
- **The Dart library** is `sodium`, not the discontinued `sodium_libs` (E12-R02).
