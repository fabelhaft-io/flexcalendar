# `spec/crypto.md` — the CalFlex Private-calendar wire format

**Owning requirement:** [E12-R01](../docs/epics/E12-crypto-core.md) · **Epic:** [E12 — Crypto core
and shared test vectors](../docs/epics/E12-crypto-core.md) · **Normative source:** ADR 0001
§ Private calendars — cryptography (with the amendments for D-06, D-07, D-08, D-14, D-15, D-17 and
D-18) and ADR 0002 § Consequences (D-16).

**Status:** version 1 (`*‑v1` labels). Frozen once E12-R03 passes: the vectors in
[`crypto-vectors/`](crypto-vectors/README.md) are the contract for
[`packages/crypto_dart`](../packages/crypto_dart/README.md) (Phase 2) and
[`packages/crypto-ts`](../packages/crypto-ts/README.md) (Phase 5), which must produce
byte-identical output.

Everything here describes **one thing**: what a client writes to, and reads from, a Private
calendar. Neither library is linked by the API or the CalDAV service, and no server log carries a
byte of an envelope, a wrap, a record or a payload (INV-07). The three servers — Node/ICU in the
API, SabreDAV/PHP in the CalDAV service, Postgres — treat every blob in this document as opaque.

**How to read this document.** `MUST`, `MUST NOT`, `SHOULD` are RFC 2119. `§` refers to a section
of this file. Every format below starts with a version byte or a domain label that ends in `v1`,
so a later change is a **new version**, never a silent reinterpretation of the same bytes. Where
this spec pins a value the server already enforces
(`server/api/src/calendar-envelope.mjs`), the constants are named here too, so an implementer can
reconcile the two.

> **Test values.** Every key, nonce, seed, word list, event and calendar in this document and in
> `spec/crypto-vectors/` is invented for the tests. No real key material appears anywhere in this
> directory.

---

## 0. Conventions

### 0.1 Bytes, integers, text

| Rule | Definition |
|---|---|
| Byte order | Every multi-byte integer in a fixed layout is **unsigned, big-endian** (“network order”). |
| Text | UTF-8, no BOM, no normalisation, unless a format says otherwise. |
| ASCII | The 7-bit subset; any label defined here is ASCII. |
| Domain label | A fixed ASCII string that starts a framed message. It is **never** length-prefixed; it always ends in `-v1`. |
| Framed message | `label ‖ field*`, where every field is `lp32(bytes)`. |
| `lp32(b)` | `u32 BE byte length of b ‖ b`. The length counts **bytes**, not characters. A field may be zero-length (only where stated). |
| Canonical decimal | ASCII `0`–`9`, no sign, no `+`, no leading zero unless the value is exactly `0`. |
| `u32 BE` | 4 bytes, `0`…`4 294 967 295`. |

### 0.2 Transport encodings

| Name | Definition |
|---|---|
| `hex` | Lowercase hexadecimal, `[0-9a-f]`, even length, no separators, no `0x`. A decoder **MUST** refuse uppercase, odd length and any other character (`E_ENCODING`). |
| `b64` | RFC 4648 §4 standard alphabet (`A–Z a–z 0–9 + /`) **with** `=` padding, no whitespace, no line breaks. Canonical only: a decoder **MUST** refuse a string whose re-encoding differs from the input (`E_ENCODING`). This is the encoding of an envelope on the wire (`metaEnvelope`, OpenAPI `format: byte`) and the encoding of a blob that reaches the API. |
| `b64u` | RFC 4648 §5 URL-safe alphabet (`A–Z a–z 0–9 - _`) **without** padding. Only used inside `calflex://` URI payloads. A decoder **MUST** refuse `=` and any other character (`E_ENCODING`). |
| UUID | Lowercase RFC 4122 §3 canonical text `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, 36 bytes. |
| Raw UUID | The same 16 bytes with the dashes removed, in the order of the hex digits (no byte-order change). |
| Instant | `YYYYMMDDTHHMMSSZ` (RFC 5545 `DATE-TIME` in UTC, always with `Z`). |
| Local time | `YYYYMMDDTHHMMSS`, no `Z`, no `TZID` (the zone travels beside it). |

Every identifier that a database generates — `calendar_id`, `user_id`, the `device_links`
rendezvous id, and a `UID` created in a Private calendar — is a random UUIDv4 (INV-03, E04-R06,
E03-R11). A decoder that is handed a non-v4 or non-canonical UUID **MUST** refuse it
(`E_ENCODING`).

### 0.3 Error codes

A library returns one of these codes for every refusal. The codes are part of the contract
because the vectors name them; a caller **MUST NOT** be able to tell a wrong key from a flipped
tag byte (both are `E_AUTH`).

| Code | Meaning |
|---|---|
| `E_VERSION` | A version byte or label version this implementation does not know, or a kind byte that contradicts the kind the caller asked for. |
| `E_LENGTH` | Too short, too long, or a fixed field of the wrong size. |
| `E_EPOCH` | An epoch outside `0 … 2 147 483 647`. |
| `E_ENCODING` | Non-canonical hex/base64/base64url/UUID/decimal, or a field of the wrong type. |
| `E_AUTH` | AEAD tag verification failed: wrong key, wrong AAD, flipped ciphertext or tag bit, truncation **inside** the ciphertext, or the wrong envelope kind. No partial plaintext is ever returned. |
| `E_PAYLOAD` | The plaintext is not valid UTF-8 or not valid JCS JSON, or its members violate §4 (`null`, a forbidden member, a missing required member, a duplicate member name, a non-integer number). Also: unwrapped key material that does not match the public keys it claims. |
| `E_SIGNATURE` | Ed25519 verification failed, or the blob carries no signature. |
| `E_SKELETON` | A skeleton property is missing, not canonical, or contradicts another property. |
| `E_RECOVERY` | A recovery phrase that is not 12 known words from the pinned list, or whose checksum fails. |
| `E_VERIFY` | A `calflex://` payload whose contents contradict each other (fingerprint vs key, verification code vs keys, repeated or unknown parameter). |
| `E_UNSUPPORTED` | Well-formed input that version 1 deliberately does not process (a floating time, an `X-` rule part, an `escrow` wrap, a key suite this version does not implement, a leap second). |

**Order of checks.** Two implementations must agree on *which* code a given bad input produces, so
every operation below states its check order. The order exists to keep the outward behaviour
uniform: a structurally broken input fails before any key material is touched, and no failure ever
reveals which part of a *secret* failed.

---

## 1. The envelope

One envelope per event, and one more per calendar (its name and colour). Both are the same byte
layout, keyed with the same calendar content key (CCK) for the same epoch; they are told apart by
the **domain label in the AAD** (§2.4), never by a byte in the header. The header is what the API
can check without a key (`ENVELOPE_VERSION`, `ENVELOPE_FIXED_BYTES`, `MAX_ENVELOPE_BYTES` in
`server/api/src/calendar-envelope.mjs`).

### 1.1 Layout

| Offset | Size | Field | Contents |
|---|---|---|---|
| 0 | 1 | version | `0x01`. No other value is accepted. |
| 1 | 4 | epoch | CCK epoch, `u32 BE`. `0 … 2 147 483 647`. |
| 5 | 24 | nonce | XChaCha20 nonce, from the CSPRNG, fresh for every seal. |
| 29 | *n* | ciphertext | The payload (§4) encrypted with XChaCha20-Poly1305. *n* is the plaintext length: the cipher is a stream cipher, so there is no padding and no length hiding. |
| 29+*n* | 16 | tag | Poly1305 tag over the AAD, the ciphertext and the lengths. |

Total length = **45 + *n*** bytes. 45 = 1 + 4 + 24 + 16 is `ENVELOPE_FIXED_BYTES`.

| Bound | Value | Where |
|---|---|---|
| Event envelope | 45 … **65 536** bytes | Client-side ceiling (`MAX_EVENT_ENVELOPE_BYTES`). The API does not check this; see §9. |
| Calendar-metadata envelope | 45 … **4096** bytes | Enforced by the API on create/rename (`MAX_ENVELOPE_BYTES`). |
| Epoch | `0 … 2 147 483 647` | `MAX_EPOCH` = `2^31 − 1`. The wire field is a `u32`; Postgres `calendars.meta_epoch`, `event_envelopes.epoch` and `calendar_keys.epoch` are `integer`, so the cap is the cheaper side. |

Epoch `0` is legal in the format but never produced by our clients: a Private calendar's first CCK
is at **epoch 1** (E13-R01), and a rotation that removes a member starts N+1. The format accepts 0
so that a future epoch numbering scheme does not need a new version.

### 1.2 Sealing

AEAD: **XChaCha20-Poly1305** (IETF, `crypto_aead_xchacha20poly1305_ietf_*`), 32-byte key
(`cck`), 24-byte nonce, AAD as in §2.

1. Check the epoch is in range → else `E_EPOCH`.
2. Build the payload bytes (§4: JCS, UTF-8) → `E_PAYLOAD` if it violates §4.
3. Build the AAD (§2) from the calendar id, the skeleton values and **the same epoch** → a bad
   skeleton is `E_SKELETON`, a bad encoding is `E_ENCODING`.
4. Draw 24 bytes from the CSPRNG (`randombytes_buf`). The nonce is **never** a caller argument in
   production code: the public `seal(cck, epoch, skeleton, payload)` of E12-R03 generates it.
   A vector test needs a deterministic seal, so a conforming implementation also exposes a
   **test-only** entry point that takes the nonce; nothing else may call it, and it is not part of
   the library's public API surface.
5. `c = AEAD_encrypt(message = payload, aad, nonce, key = cck)` → `version ‖ epoch ‖ nonce ‖ c`
   (the tag is the last 16 bytes of `c`).
6. Check the total against the applicable ceiling → else `E_LENGTH`.

A nonce **MUST NOT** be reused under one key: reusing it under XChaCha20-Poly1305 is a
catastrophic failure (XOR of two plaintexts, forged tags). The CSPRNG of the device is the only
source; a counter is not used, because a device that loses its counter state would reuse nonces.

### 1.3 Opening

1. Length ≥ 45 → else `E_LENGTH`.
2. `bytes[0] == 0x01` → else `E_VERSION`.
3. `epoch = u32 BE at 1`; `epoch ≤ 2 147 483 647` → else `E_EPOCH`.
4. Build the AAD from the caller's skeleton and the **epoch from the header** (never from a
   separate argument, so the two can never disagree) → `E_SKELETON` / `E_ENCODING`.
5. `AEAD_decrypt(bytes[29:], aad, nonce = bytes[5:29], key = cck)` → on any failure `E_AUTH`. The
   plaintext is not returned partially, and the failure is identical for a wrong key, a flipped
   tag, a flipped ciphertext byte and a mismatched AAD.
6. Validate the plaintext per §4 → else `E_PAYLOAD`.

An implementation **MUST NOT** open an envelope before it has verified that the skeleton's
`X-CALFLEX-ENVELOPE-SHA256` matches those envelope bytes (§5.1). That ordering is E13-R02's read
path; it is stated here because it is the only defence against a server that serves the *older*
envelope after a crash between D-06's write steps.

### 1.4 Envelope kinds

| Kind | AAD label (§2.4) | AAD fields | Purpose |
|---|---|---|---|
| Event envelope | `calflex-v1` | 7 | One `VEVENT`'s content. |
| Calendar-metadata envelope | `calflex-meta-v1` | 2 | A Private calendar's name and colour (D-18). |

The two labels differ in **byte 8** (`v` vs `m`), so no choice of field bytes can make the two
AADs equal. Opening a metadata envelope with the event AAD, or the reverse, therefore fails
`E_AUTH` (§2.5, vectors `metadata-open-as-event`, `event-open-as-metadata`).

---

## 2. The canonical AAD

The AAD is the only thing that binds an envelope to its place. It is a framed message (§0.1): a
domain label, then length-prefixed UTF-8 fields **in a fixed order**, with no optional fields and
no absent field (an inapplicable field is written as an empty or fixed literal, never omitted).

### 2.1 Framing

```
aad = label ‖ lp32(field_1) ‖ lp32(field_2) ‖ … ‖ lp32(field_k)
```

- `label` — ASCII, not length-prefixed, from the table in §2.4.
- `lp32` — 4-byte big-endian byte length, then the UTF-8 bytes. Every field in this spec's AADs is
  UTF-8 text; a field that could contain a `NUL` (a `UID`, a `SUMMARY`) still carries its raw
  UTF-8 bytes, because the length prefix — not a terminator — delimits it.
- Field **count** is fixed by the label. A reader **MUST NOT** accept a message with a different
  number of fields: 12 bytes of `"calflex-v1"` plus the 7 fields is the whole thing.
- Length prefixes exist so that concatenation is unambiguous. `("ab","c")` and `("a","bc")` must
  not produce the same AAD, and with `lp32` they do not.

### 2.2 Event envelope AAD — label `calflex-v1`

| # | Field | Bytes | Encoding |
|---|---|---|---|
| 1 | `calendar_id` | 36 | Canonical lowercase UUIDv4 of the calendar. |
| 2 | `uid` | 1…255 | The owning `VEVENT`'s `UID` **value** as parsed: unfolded (RFC 5545 §3.1) and unescaped (§3.3.11). |
| 3 | `recurrence_id` | 0 or 8/15 | The canonical `recurrence_id` of §5.2. **Zero-length for the master** — the only field in any AAD that may be empty. |
| 4 | `epoch` | 1…10 | Canonical decimal of the epoch in the envelope header. |
| 5 | `dtstart` | 8… | Canonical `DTSTART` (§3.1). |
| 6 | `end` | 4… | Canonical end: `DTEND` or `DURATION`, or the literal `none` (§3.2). |
| 7 | `rrule` | 4… | Canonical `RRULE`, or the literal `none` (§3.3). |

Field 4 is derived from the header, never from a separate argument (§1.3 step 4), so a caller
cannot seal an envelope whose AAD says one epoch and whose header says another.

### 2.3 Calendar-metadata envelope AAD — label `calflex-meta-v1`

| # | Field | Bytes | Encoding |
|---|---|---|---|
| 1 | `calendar_id` | 36 | Canonical lowercase UUIDv4. |
| 2 | `epoch` | 1…10 | Canonical decimal, equal to the envelope header's epoch (and to the API's `metaEpoch`). |

D-18: the label, the calendar id and the epoch are what make a metadata envelope unable to open as
an event envelope. The metadata envelope's *payload* (§4.3) is what carries the name and colour.

### 2.4 Other framed messages

The same framing is used by the signed messages of the key hierarchy (§6). Their labels are
distinct from the two above and from each other:

| Label | Used by | § |
|---|---|---|
| `calflex-v1` | Event envelope AAD | §2.2 |
| `calflex-meta-v1` | Calendar-metadata envelope AAD | §2.3 |
| `calflex-keywrap-v1` | AAD of a wrapped private key | §6.3 |
| `calflex-cck-record-v1` | Signed message of a sealed CCK record | §6.6 |
| `calflex-link-bundle-v1` | Signed message of a device-link key bundle | §6.7 |

Two more labels are **not** framed messages: `calflex-id-v1` starts the fingerprint hash and
`calflex-safety-v1` the safety number (§6.8), and `calflex-link-code-v1` the verification code
(§6.7). All of them are ASCII and end in `v1`; none of them is ever used as an AEAD AAD except the
three in the table's first two rows and `calflex-keywrap-v1`.

### 2.5 What the AAD buys, and what it does not

- It makes server-side tampering with the **timing** detectable: the API rewrites skeletons
  (D-07's plans), and a rewrite of `DTSTART`, `DTEND`/`DURATION` or `RRULE` changes the AAD, so
  the tag no longer verifies.
- It stops the server **moving** an envelope: to another calendar (field 1), another event
  (field 2), another override of the same event (field 3) or another epoch (field 4).
- It does **not** hide timing, recurrence or the number of events — those stay cleartext by
  design (D-08, ADR 0001 § “What we can and cannot claim”).
- It is **not** a substitute for the frame's own integrity: an `EXDATE` the API adds, a
  `VALARM`'s fixed description and a rewritten `SEQUENCE` do not change the AAD (§5.3).

### 2.6 `RDATE` and `EXDATE` are **not** bound

The epic asks for this decision with reasons; the answer is **not bound**, and no AAD field
carries either property.

1. **INV-05 says the client never writes them.** Clients send edit intents; the API writes
   `EXDATE` and `RECURRENCE-ID` with `ical.js` (ADR 0002, E05-R07). If `EXDATE` were bound, an
   `EXDATE` the API adds *after* the client sealed the master's envelope would invalidate that
   envelope — the master's content has not changed, and the read path would break for a change
   nobody made. D-07's two-step plan exists precisely because the fields that *are* bound
   (`UNTIL` on the master, for instance) must be re-sealed; adding `EXDATE` to that set would
   force a re-seal of the master for every "this and following" edit, doubling the envelope
   writes and the window for a mismatch.
2. **They carry timing only, and timing is already cleartext** (D-08). A reader that can see the
   skeleton can expand the rule and see which occurrences the `EXDATE`s remove. Forging an
   `EXDATE` is a denial-of-service on one client's view, not a disclosure: it cannot expose a
   `SUMMARY` the client does not already hold. The integrity that matters — that the *content*
   belongs to this event, at this epoch — is intact.
3. **They are lists that grow and shrink.** A recurrence's occurrence list is exactly what
   E05-R07's expansion plans rewrite, and field 5–7 are bounded and small (one rule, one pair of
   times), while an `EXDATE`/`RDATE` list is unbounded. Binding it would put an unbounded,
   API-owned property into a value the client signs off on.
4. **The ADR already fixes the triple.** ADR 0001 § Private calendars pins
   `canonical(DTSTART, DTEND, RRULE)`; changing that is an ADR amendment, not a spec decision.

The skeleton still carries `RDATE` and `EXDATE` (they are in E03-R09's allow-list), and INV-02
still requires them to survive a round trip. They are simply not part of what the envelope binds.
---

## 3. Canonical timing fields

Fields 5–7 of the event AAD are computed from the **parsed** iCalendar values, never from the
property text as it happens to be spelled in the stored object. That is the requirement's point:
re-serialising a skeleton (E05-R07's plans run `ical.js` over it and write it back) may change
spelling — part order, an explicit default, a `+` sign — without changing the meaning, and a
spelling-insensitive AAD is the only one that survives it.

### 3.1 `DTSTART` (field 5)

```
dtstart = "date:"  datestr
        | "utc:"   instant
        | "zoned:" tzid "@" localtime
datestr    = 8DIGIT                       ; YYYYMMDD, proleptic Gregorian
instant    = 8DIGIT "T" 6DIGIT "Z"        ; YYYYMMDDTHHMMSSZ
localtime  = 8DIGIT "T" 6DIGIT            ; YYYYMMDDTHHMMSS, no Z
tzid       = an IANA zone name, exactly as the TZID parameter spelled it
```

| Skeleton property | Field 5 |
|---|---|
| `DTSTART;VALUE=DATE:20260401` | `date:20260401` |
| `DTSTART:20260401T090000Z` | `utc:20260401T090000Z` |
| `DTSTART;TZID=Europe/Berlin:20260401T110000` | `zoned:Europe/Berlin@20260401T110000` |

Rules:

- All numeric components are zero-padded to their fixed width (RFC 5545 §3.3.4/§3.3.5).
- The `TZID` written is the parameter's value **exactly as parsed**, not a normalised or
  re-resolved spelling. `Asia/Calcutta` and `Asia/Kolkata` are different field values, so an
  implementation **MUST NOT** canonicalise link names — a `TZID` rewrite is a skeleton change and
  must be seen as one (it breaks the tag, which is the detection the ADR wants). E05-R07's writer
  therefore must not normalise zone names; recorded in §9.
- A `DATE-TIME` with no `Z` and no `TZID` is **floating** and is refused with `E_UNSUPPORTED`
  (INV-04: every `DTSTART`/`DTEND` carries a `TZID` or `Z`).
- Seconds `60` (a leap second) are refused with `E_UNSUPPORTED`; the AAD has no representation for
  one, and no object this API writes can carry one.
- A `DATE-TIME` with a `TZID` whose zone cannot be resolved: the field is still built from the
  wall clock and the `TZID` (no zone data is needed), so it is *not* refused here. The client that
  has to show it or expand it has a separate problem (E15-R02).

### 3.2 The end (field 6)

An event carries **at most one** of `DTEND` and `DURATION` (RFC 5545 §3.6.1). (The API's writer always writes one for a timed event and `DTEND` for an all-day event, but the format does not rely on that.)

```
end = "none"
    | "date:"  datestr
    | "utc:"   instant
    | "zoned:" tzid "@" localtime
    | "dur:"   duration
```

| Skeleton | Field 6 |
|---|---|
| `DTEND;TZID=Europe/Berlin:20260401T120000` | `zoned:Europe/Berlin@20260401T120000` |
| `DTEND:20260401T100000Z` | `utc:20260401T100000Z` |
| `DTEND;VALUE=DATE:20260402` | `date:20260402` |
| `DURATION:PT1H30M` | `dur:PT1H30M` |
| neither property | `none` |

Both present → `E_SKELETON`. `date:`/`utc:`/`zoned:` follow §3.1's rules.

#### 3.2.1 Durations

```
duration = ["-"] "P" ( weekform | daytimeform )
weekform    = 1*DIGIT "W"
daytimeform = [ 1*DIGIT "D" ] [ "T" [ 1*DIGIT "H" ] [ 1*DIGIT "M" ] [ 1*DIGIT "S" ] ]
```

From the parsed duration (`ICAL.Duration` / the equivalent in each runtime):

- Components are emitted **exactly as parsed**: no carrying (`PT60M` stays `PT60M`, never `PT1H`),
  no conversion between weeks/days and hours. A `P1D` and a `PT24H` are *not* the same duration —
  RFC 5545 §3.3.6 makes a day and a week nominal, and they differ across a DST transition — so
  converting either way would silently change the event. Minutes and seconds are likewise emitted
  where they were, so that the AAD is a function of the parsed value and nothing else.
- A leading `+` is not emitted; a negative duration keeps `-`.
- Zero components are omitted: `-P0DT0H0M0S` → `PT0S`. A duration of zero is written `PT0S`.
- `T` appears if and only if at least one of H, M, S is non-zero.
- Weeks are emitted only alone (RFC 5545 forbids `P1W2D`).
- `P` alone, `PT` alone, more than one sign, or a component without a leading digit
  (`P1H`) → `E_SKELETON`.

### 3.3 `RRULE` (field 7)

```
rrulefield = "none" | "rrule:" rule
rule       = "FREQ=" freq *( ";" part )
```

Parts appear **in this fixed order**, uppercase, `;`-separated, with no spaces, each at most once:

```
FREQ ; [ UNTIL | COUNT ] ; [ INTERVAL ] ; BYSECOND ; BYMINUTE ; BYHOUR ; BYDAY ;
BYMONTHDAY ; BYYEARDAY ; BYWEEKNO ; BYMONTH ; BYSETPOS ; WKST
```

(RFC 5545 §3.3.10's `recur-rule-part` order, which also fixes `UNTIL` before `COUNT` — they are
mutually exclusive.)

| Part | Canonical form |
|---|---|
| `FREQ` | One of `SECONDLY MINUTELY HOURLY DAILY WEEKLY MONTHLY YEARLY`, uppercase. **Required**; a rule without it is `E_SKELETON`. |
| `UNTIL` | A `DATE` → `YYYYMMDD`; a `DATE-TIME` → its **UTC instant** `YYYYMMDDTHHMMSSZ` (RFC 5545 requires `UNTIL` to be UTC when `DTSTART` has a `TZID`). A floating `UNTIL` → `E_SKELETON`. |
| `COUNT` | Canonical decimal `>= 1`. |
| `INTERVAL` | **Omitted when `1`** (the RFC's default); otherwise canonical decimal `>= 2`. |
| `BYSECOND` `BYMINUTE` `BYHOUR` `BYMONTHDAY` `BYYEARDAY` `BYWEEKNO` `BYMONTH` `BYSETPOS` | Values ascending by numeric value, duplicates removed, comma-separated, canonical decimals. A leading `+` is dropped (`+2` → `2`). |
| `BYDAY` | Entries `[n]WK` with `WK` uppercase; `+2MO` → `2MO`. List sorted by (weekday index Monday=0 … Sunday=6, then the ordinal with an ordinal-less entry sorting as 0), duplicates removed. |
| `WKST` | Uppercase weekday, **omitted when `MO`** (the RFC's default). |

Ranges are checked (RFC 5545 §3.3.10): `BYSECOND` 0–60, `BYMINUTE` 0–59, `BYHOUR` 0–23,
`BYMONTHDAY` ±1–31, `BYYEARDAY` ±1–366, `BYWEEKNO` ±1–53, `BYMONTH` 1–12, `BYSETPOS` ±1–366,
`BYDAY`'s ordinal ±1–53. An out-of-range value is `E_SKELETON`.

Refusals: an unknown rule part **including any `X-` part** (`E_UNSUPPORTED` — the owner's ruling of
2026-10-12 forbids `X-` in an `RRULE`); a part that appears twice (`E_SKELETON` — a last-one-wins
parser would be a malleability hole, because two spellings would produce one AAD only by
accident); an empty rule (`E_SKELETON`); no `RRULE` at all → the literal `none` (a `DTSTART` with
only `RDATE`s is legitimate — `spec/ical-fixtures/ours/private-rdate.ics`).

**Two spellings, one field.** These are the pairs the vectors pin:

| Skeleton `RRULE` | Field 7 |
|---|---|
| `FREQ=DAILY;INTERVAL=1;COUNT=5` | `rrule:FREQ=DAILY;COUNT=5` |
| `FREQ=DAILY;COUNT=5` | `rrule:FREQ=DAILY;COUNT=5` |
| `FREQ=MONTHLY;BYDAY=-1FR,2MO;WKST=MO` | `rrule:FREQ=MONTHLY;BYDAY=2MO,-1FR` |
| `FREQ=MONTHLY;BYMONTHDAY=30,15,30` | `rrule:FREQ=MONTHLY;BYMONTHDAY=15,30` |
| `FREQ=WEEKLY;BYDAY=TU,TH;COUNT=10` | `rrule:FREQ=WEEKLY;COUNT=10;BYDAY=TU,TH` |
| `FREQ=DAILY;UNTIL=20260401T090000Z` | `rrule:FREQ=DAILY;UNTIL=20260401T090000Z` |

### 3.4 DST: one answer per ambiguous local time

The AAD's fields 5 and 6 carry the `TZID` and the **wall clock**, so they are independent of any
zone database (§3.5). Everything else that turns such a value into an instant — the recurrence
expander, the free/busy feed, a viewer in another zone — must still give one answer, and we pin
RFC 5545's, not any library's:

- **A local time that does not exist** (inside a spring-forward gap) is read with the offset in
  force **before** the gap (RFC 5545 §3.3.5, form 3).
- **A local time that occurs twice** (an autumn overlap) refers to the **first** occurrence, i.e.
  the pre-transition offset (same section).
- **A recurrence instance whose computed local time does not exist** is kept, counted, and placed
  with the offset before the gap — the owner's ruling of 2026-10-12 on RFC 5545 §3.3.10
  (`docs/02` § Recurrence, `spec/ical-fixtures/dst/README.md`).

| Input | Instant | Why |
|---|---|---|
| `TZID=Europe/Berlin:20260329T023000` | `20260329T013000Z` | Skipped: `+01:00` before the gap. |
| `TZID=Europe/Berlin:20261025T023000` | `20261025T003000Z` | Repeated: the first occurrence, `+02:00`. |

Both are also cases 4 and 9 of `spec/ical-fixtures/dst/cases.json`
(`berlin-2026-spring-skipped`, `berlin-2026-fall-repeated`), which is the fuller table and the
authority for everything else; `crypto-vectors/canonical-timing-v1.json` carries both as vectors
next to their canonical AAD field, so the libraries can assert the RFC answer *and* the bound
value.

**Known trap, recorded so nobody re-derives it:** with a `VTIMEZONE` present, `ical.js` maps
`20260329T023000` to `20260329T003000Z` (the offset *after* the gap) and `20261025T023000` to the
**second** occurrence. That is exactly why the AAD binds the wall clock and the `TZID` — the
envelope stays readable no matter what a given library's zone handling does — and why the client,
not `ical.js`, decides the UTC instant when one is needed.

### 3.5 Zone data: what is bound, and why it survives a tz update

The AAD binds **the `TZID` and the local wall clock** for a zoned value, and the UTC instant that
is literally written in the skeleton for a `Z` value. It never binds "the instant my zone
database computes", and it never binds a `VTIMEZONE` component.

1. **A tz update must not break stored envelopes.** Zone rules change (the E05-R09 review found a
   host where `Africa/Casablanca` after September 2026 and `Asia/Tehran` in 1979 disagree between
   tz 2026b and 2026e). If the AAD held the UTC instant, every envelope whose local time sits in a
   changed rule would stop opening — a data-loss-shaped outage for a purely informational update.
   The wall clock and the zone name of such an event have not moved, and the bound bytes do not
   either.
2. **Four runtimes, four zone versions.** Node's ICU (tz 2026b on the pinned Node 24.17), the Dart
   `timezone` package, the browser's ICU and Android's `java.time` each carry their own tzdata, so
   "the instant" is a function of *which build* you ask. A wire format whose AAD depends on that
   cannot be implemented byte-identically by two libraries.
3. **It is still tamper-evident for the value the server holds.** The API stores the local time and
   the `TZID` in the skeleton; that is what field 5 and 6 cover, exactly.
4. **All-day events bind a date**, never a midnight instant: `date:20260401` for
   `DTSTART;VALUE=DATE:20260401` (INV-04 — an all-day event is `VALUE=DATE`, and never a
   midnight-to-midnight date-time).

---

## 4. The payload

The plaintext of an envelope is the **JCS** (RFC 8785) serialisation of a JSON object whose member
names are **JSCalendar** (RFC 8984) names. The two envelope kinds have two payload objects; there
is no third.

### 4.1 JCS rules that matter here

The reference serialiser is RFC 8785 itself — a conforming implementation may use any JCS library,
but `spec/crypto-vectors/payload-jcs-v1.json` (generated by a hand-written serialiser that is
cross-checked against `rfc8785`) is the target. The rules a payload can trip:

- Output is **UTF-8, no BOM, no trailing newline**.
- Object members are sorted by **UTF-16 code unit** order of the member name (for the ASCII and
  Latin-1 names here, that is byte order; `"@"` (U+0040) sorts before every letter, so `@type` is
  always first).
- Strings: `"` and `\` escape as `\"` and `\\`; U+0008, U+0009, U+000A, U+000C, U+000D use the short
  escapes `\b \t \n \f \r`; every other C0 control is `\u00xx` with **lowercase** hex digits.
  Nothing else is escaped: non-ASCII (including U+2028/U+2029 and emoji) is written as raw UTF-8,
  **never** as `\uXXXX`. This is the difference most often missed, and
  `payload-jcs-v1.json` has a `Grüße`/emoji vector for it.
- Numbers: integers only (§4.2), written as decimal digits, `-` for negatives, no `+`, no leading
  zero, no exponent, no fractional part — which is what ECMAScript's `Number::toString` produces
  for every safe integer.
- No whitespace anywhere. No `null` member value (§4.2).

### 4.2 Event payload

**Required:** `@type`, the string `"Event"` (RFC 8984 §4.1.1).

**Optional** (the complete allow-list for version 1; a member outside it is `E_PAYLOAD`, at seal
**and** at open, so adding one is a new version rather than a silent divergence):

| Member | JSCalendar type | Notes |
|---|---|---|
| `title` | String | The event title. The single most sensitive field. |
| `description` | String | |
| `descriptionContentType` | String | e.g. `text/plain`. |
| `locations` | map of Location | `name`, `description`, `coordinates`, `timeZone`, `links`. |
| `virtualLocations` | map of VirtualLocation | `name`, `description`, `uri`. |
| `links` | map of Link | `href`, `contentType`, `size`, `rel`, `display`, `title`. |
| `participants` | map of Participant | `name`, `email`, `description`, `roles`, `kind`, `participationStatus`, `expectReply`, `sendTo`, `locationId`, `links`, `language`. **D-08: `ATTENDEE` lives here, encrypted, and a Private calendar has no email invites.** |
| `replyTo` | map of Boolean | **D-08: the organiser.** |
| `keywords` | map of Boolean | iCalendar `CATEGORIES`-adjacent free tags. |
| `categories` | map of Boolean | |
| `locale` | String | BCP 47. |
| `priority` | Integer 0–9 | |
| `freeBusyStatus` | String | `free` or `busy`. |
| `status` | String | `confirmed`, `cancelled`, `tentative`. |
| `color` | String | RFC 7986 colour value, lowercase. |
| `relatedTo` | map of Relation | `relation`, `@type`. |

**Forbidden** — present at all is `E_PAYLOAD`. They are either bound by the skeleton, written by
the API, or belong to a `VALARM`:

`uid`, `start`, `duration`, `due`, `timeZone`, `recurrenceRules`, `recurrenceOverrides`,
`excludedRecurrenceRules`, `sequence`, `created`, `updated`, `prodId`, `method`, `alerts`,
`useDefaultAlerts`, `isDraft`, `serverId`, `@type` with any value but `"Event"`.

The reason for the forbidden list is the same in every case: the skeleton (E03-R09's allow-list)
already carries those properties in the clear, the AAD binds the ones that matter, and a copy
inside the payload would be a second authority that can disagree with the first — the exact defect
ADR 0001 warns about for `RECURRENCE-ID`.

**Structural rules.** Members whose value is `null` → `E_PAYLOAD`. Numbers must be integers with
`|n| ≤ 2^53 − 1` (a float or an exponent form → `E_PAYLOAD`); our payload uses integers only for
`priority` and `size`. A duplicate member name → `E_PAYLOAD` (JSON parsers silently take the last
one, which would make two different plaintexts serialise to one payload). A payload that is not a
JSON object → `E_PAYLOAD`. An empty payload (0 bytes) → `E_LENGTH` at seal.

### 4.3 Calendar-metadata payload

**Required:** `@type` = `"Calendar"` (RFC 8984 §5.1), `name`, `color`. **No other member**, and no
forbidden one — the calendar's name and colour are the whole point (D-18), and the epoch lives in
the AAD, not in the payload.

| Member | Rule |
|---|---|
| `name` | String, 1 … 255 UTF-8 bytes. Must not be empty. |
| `color` | String, RFC 7986 §3.1: `#` followed by 6 or 8 lowercase hex digits (`#rrggbb`, `#rrggbbaa`). |

```json
{"@type":"Calendar","color":"#3b82f6","name":"Privat"}
```

A payload with any further member is `E_PAYLOAD`. Note that this payload is *not* interchangeable
with the event payload: the required `@type` differs, and the members do too.

---

## 5. Skeleton bindings

The skeleton is the cleartext `VEVENT` an API may read; the envelope is opaque to it. Two skeleton
values are pinned by E04-R04 and used here unchanged.

### 5.1 `X-CALFLEX-ENVELOPE-SHA256`

- **Value:** the SHA-256 of the **complete envelope bytes** — offset 0 through the last tag byte,
  45 + *n* bytes, exactly as stored in `event_envelopes.envelope` and as sent in a request body.
  Not the hash of the ciphertext alone, not the hash of the payload, not the hash of the AAD.
- **Text form:** 64 lowercase hex digits. `envelope_sha256` in `event_envelopes` is the same 32
  bytes as `bytea`; the skeleton property is their `hex` per §0.2.
- **Reader rule:** a client **MUST NOT** open an envelope unless the property is present on the
  `VEVENT` (or `VALARM`? no — on the `VEVENT`, E03-R09) and its decoded bytes equal the SHA-256 of
  the bytes it is about to open. Missing property, wrong length, uppercase or non-hex →
  `E_SKELETON`. This is D-06's gate: it keeps a crash between the envelope insert and the skeleton
  `PUT` from showing a newer envelope with an older skeleton, and it makes a content-only edit
  visible to every other client through the `ETag`/sync-token.
- **Write order** (D-06, restated because the hash is computed over the envelope before it is
  stored): insert the envelope row, `PUT` the skeleton with `If-Match` carrying the new hash, then
  garbage-collect the superseded row.

Vectors: `envelope-v1.json` `envelope-sha256-*` — the hash of each fixed envelope, the hash of that
envelope with one bit flipped (different), and an uppercase-hex value that must be refused.

### 5.2 Canonical `recurrence_id` (E04-R04)

The value in the sidecar column, in the AAD's field 3, and — spelled as a property — in the
skeleton:

| Skeleton | `recurrence_id` |
|---|---|
| no `RECURRENCE-ID` (the master) | `""` (zero-length; `NULL` in the database) |
| `RECURRENCE-ID;TZID=Europe/Berlin:20260401T110000` | `20260401T090000Z` |
| `RECURRENCE-ID:20260401T090000Z` | `20260401T090000Z` |
| `RECURRENCE-ID;VALUE=DATE:20260401` | `20260401` |

- A `DATE-TIME` is **converted to UTC** and written as an instant; a `DATE` is written as eight
  digits; the master is empty. RFC 5545 matches overrides by instant, so one occurrence has one
  key whichever way its `RECURRENCE-ID` was written — the third accept criterion of E04-R04, and
  vector `aad-recurrence-id-two-spellings` proves both spellings produce one AAD.
- A floating `RECURRENCE-ID` (no `Z`, no resolvable `TZID`) → `E_SKELETON`, matching
  `recurrenceKey` in `server/api/src/recurrence-key.mjs`, which refuses it rather than treating a
  local clock as UTC.
- This field is what makes D-14's second addition work: an override's envelope cannot be opened
  as the master's (empty vs `…Z`) or as another override's (different instant).

### 5.3 What the skeleton binds, and what it does not

| Skeleton property | Bound into the AAD? | Why |
|---|---|---|
| `UID` | Yes (field 2) | The one identifier that travels everywhere (object name, outbox, delta feed, sidecar key). |
| `RECURRENCE-ID` | Yes (field 3, canonical form) | D-14. |
| `DTSTART` | Yes (field 5) | ADR 0001. |
| `DTEND` / `DURATION` | Yes (field 6) | ADR 0001; at most one of the two. |
| `RRULE` | Yes (field 7) | ADR 0001, canonical per §3.3. |
| `RDATE`, `EXDATE` | **No** | §2.6. |
| `SEQUENCE`, `DTSTAMP`, `CREATED`, `LAST-MODIFIED`, `PRODID` | No | Written by the API from its own data (E03-R09); no confidentiality. |
| `VALARM` | No | D-08: cleartext by design, with a fixed `DESCRIPTION:Reminder`. Our clients **MUST** write that literal and never the event title, because a `VALARM` description reaches a stock app's notification. |
| `X-CALFLEX-ENVELOPE-SHA256` | Indirectly | Not a field; it is the read gate of §5.1, and it lives *inside* the skeleton, so a change to a bound value invalidates it. |
| `VTIMEZONE`, `X-LIC-LOCATION`, `TZNAME`, `TZURL` | No | Zone definitions are not part of the event, and §3.5 binds the `TZID` and the wall clock instead. |

---

## 6. Key hierarchy formats

ADR 0001's key diagram as amended by D-15 and D-17: two keypairs per user, no key derived from the
login password, and a per-calendar CCK. This section fixes the bytes of every blob the server
stores. Each blob's column is named, because the server stores every one of them opaquely.

| Blob | Column | § |
|---|---|---|
| Envelope | `event_envelopes.envelope`, `calendars.meta_envelope` | §1 |
| Wrapped private key | `user_key_wraps.wrapped_private_key` | §6.3 |
| Sealed, signed CCK record | `calendar_keys.record` | §6.6 |
| Device-link key bundle | `device_links.sealed_blob` | §6.7 |
| Ephemeral public key | `device_links.ephemeral_public_key` | §6.7 |
| Public keys | `user_keys.x25519_public_key`, `user_keys.ed25519_public_key` | §6.1 |

### 6.1 Key material

| Key | Primitive | Size | Notes |
|---|---|---|---|
| `x25519_sk` / `x25519_pk` | `crypto_box_keypair` (Curve25519) | 32 / 32 | Sealing (`crypto_box_seal`). |
| `ed25519_sk` / `ed25519_pk` | `crypto_sign_keypair` (Ed25519) | 64 / 32 | The **identity** key (D-15). `ed25519_sk` is libsodium's form: the 32-byte seed followed by the 32-byte public key. |

- Generated on the device with the platform CSPRNG. Never derived from a password, a recovery
  code or a device identifier (D-17, INV-12).
- `user_keys` holds only the two public keys, one row per user (E04-R05). A blob whose unwrapped
  key material disagrees with those public keys is refused with `E_PAYLOAD` (§6.2).
- Private keys live in Keystore/Keychain-backed storage on mobile and in memory (optionally
  IndexedDB under a non-extractable WebCrypto key) on the web (E12-R06). No other copy exists
  except the wrapped ones below.

### 6.2 Key bundle (the plaintext of a wrap or a link)

```
offset  size  field
     0     1  version = 0x01
     1     4  u32 BE length of x25519_sk = 32
     5    32  x25519_sk
    37     4  u32 BE length of ed25519_sk = 64
    41    64  ed25519_sk
               total 105 bytes
```

- Both lengths are fixed; anything else is `E_LENGTH`. (The length prefixes exist so a later
  version can add a key type without a second format.)
- On unwrap, `crypto_scalarmult_base(x25519_sk)` **MUST** equal the `user_keys.x25519_public_key`
  the caller expects, and `ed25519_sk[32:64]` **MUST** equal `user_keys.ed25519_public_key` →
  else `E_PAYLOAD`. This is the check that catches a server that swapped a stored blob between
  users.

### 6.3 Wrapped private key

```
offset  size  field
     0     1  version = 0x01
     1     1  kind: 0x01 = recovery_code, 0x02 = escrow (reserved, §6.3.2)
     2    24  nonce, from the CSPRNG, fresh per wrap
    26     n  ciphertext (a KeyBundle, n = 105)
   26+n    16  tag
               total 147 bytes for kind 0x01
```

AEAD: XChaCha20-Poly1305 with `key = KEK`, `nonce`, and

```
aad = "calflex-keywrap-v1" ‖ lp32(user_id) ‖ lp32(kind) ‖ lp32(suite)
```

**Why an AEAD and not a sealed box here.** ADR 0001's key wrapping is `crypto_box_seal`, and that
is what §6.6 and §6.7 use — but a sealed box needs a *public* key, and `KEK_rc` is a symmetric
HKDF output with no keypair behind it. A symmetric KEK can only be used with a symmetric AEAD, so
the wrap is XChaCha20-Poly1305 with the same construction as an envelope, with its own label, its
own nonce and an AAD that binds the owner and the kind. This is the one place where the ADR's
"sealed boxes" line does not apply literally; the reason is recorded in §9.

- `user_id` — canonical lowercase UUIDv4 of the **owner** of the wrap.
- `kind` — the ASCII column value, `recovery_code` (and, later, `escrow`), so the label in the AAD
  and the database's `kind` cannot drift.
- `suite` — `x25519-ed25519-v1`, the ASCII name of §6.1's pair.
- A wrap therefore cannot be moved to another user's row or to another `kind` (`E_AUTH`).

Opening a wrap, in this order: the blob must be within `MIN_WRAPPED_KEY_BYTES …
MAX_WRAPPED_KEY_BYTES` (`E_LENGTH`), the version byte must be `0x01` (`E_VERSION`), the kind byte
`0x02` is reserved (`E_UNSUPPORTED`), a kind byte that contradicts the kind the caller asked for is
`E_VERSION`, and only then is the AEAD run (`E_AUTH`). The vector file names each of those.

#### 6.3.1 The recovery-code KEK (D-17)

```
KEK_rc = HKDF-SHA-256(ikm = entropy(16 bytes), salt = "calflex-v1", info = "calflex-v1/recovery-kek", L = 32)
```

- HKDF is RFC 5869, `extract` then `expand`, `HashLen = 32`.
- `ikm` is the **16-byte entropy** recovered from the 12 words (§6.4), not the words' text: a
  differently spaced or differently cased spelling of one phrase therefore derives the same KEK,
  and no Unicode normalisation enters the derivation. A phrase is validated by its checksum
  *before* anything is derived.
- `salt` and `info` are **ASCII labels**, and every `info` in this spec is ASCII, on purpose:
  Dart's `sodium` takes HKDF's `info` as a `String` and encodes it as UTF-8, so a non-ASCII or
  arbitrary-byte label could not be expressed through that API. (`docs/verification/crypto-libs-2026-10-12.md` §4.)
- The KEK is **never stored** and never leaves the device; the server holds only the wrap.
- **No Argon2id, in any configuration** (D-17, INV-12). Argon2id reappears only if a separate
  *passphrase* option is ever added, and that would be a new spec version with its own parameters
  recorded here — not a reuse of this label.
- **No `crypto_kdf` (BLAKE2b) derivation either, and no HMAC outside HKDF.** Nothing in this
  document needs a subkey that HKDF-SHA-256 cannot produce: the CCK is random, the wrap is an AEAD,
  device linking is a sealed box, and the fingerprints, the envelope hash and the link code are
  plain SHA-256. Keeping it to HKDF-SHA-256 is also what lets the web build use the **standard**
  `libsodium-wrappers` plus WebCrypto's native HKDF, rather than the sumo build
  (`docs/verification/crypto-libs-2026-10-12.md` §§ 4–5; D-17), and it is why every HKDF `info`
  above is ASCII.

#### 6.3.2 Escrow (kind `0x02`) is reserved, not defined

Tier 1's escrow wrap is Phase 7 (E14-R01) and uses a KEK held in an HSM-backed KMS, which is not a
secret this spec can pin today. Version 1 therefore **reserves** `kind = 0x02` and a reader
**MUST** refuse it with `E_UNSUPPORTED` rather than guessing at a format. `user_key_wraps` has no
`escrow` row until E14-R01's migration drops `user_key_wraps_no_escrow_check` (E04-R05).

#### 6.3.3 Size limits the API should enforce

`user_key_wraps.wrapped_private_key` has no `octet_length` check in the schema (E04-R05 asks
E12-R01 for the numbers, because "the database has none"):

| Blob | Shortest | Longest | Today |
|---|---|---|---|
| `wrapped_private_key` | 42 (= 1 + 1 + 24 + 16) | **512** | 147 for `recovery_code` |

A blob outside those bounds is a `422` from the API. 42 is the fixed part with an empty
ciphertext; 512 leaves room for a later kind without letting a client park megabytes in a row that
is read on every device-link and recovery. A reader of version 1 with `kind = 0x01` demands
exactly 147.

### 6.4 The recovery code

D-17: the recovery code is the only path to the keys for a user who has no linked device, and it is
generated on the device, shown once, and never sent anywhere.

- **Entropy:** 128 bits from the CSPRNG.
- **Encoding:** BIP-0039, English word list. The 16 bytes are the entropy; 4 checksum bits (the
  first 4 bits of `SHA-256(entropy)`) are appended, and the resulting 132 bits are cut into twelve
  11-bit groups, most significant bit first, each an index into the 2048-word list.
- **Presentation:** the twelve words, lowercase, single spaces. The word list is BIP-0039's
  `english.txt`: 2048 lines, LF terminated, lowercase ASCII, whose
  **SHA-256 is `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`**. Both libraries
  **MUST** ship exactly those 2048 words; the generator checks the file it uses against that hash.
  (Verified: see `crypto-vectors/gen/README.md`.)
- **Typing it back in:** lowercase the input; split on runs of U+0020 or the ideographic space
  U+3000 (BIP-0039's own rule); require exactly twelve words, each in the list; verify the
  checksum. Anything else — a word not in the list, eleven or thirteen words, a failed checksum —
  is `E_RECOVERY`, reported before any key derivation so the user is not told *which* word is
  wrong.
- **Recovery procedure:** phrase → entropy → `KEK_rc` (§6.3.1) → open the `recovery_code` wrap →
  KeyBundle → the user's keys.
- **The login password is not an input anywhere** (D-17, INV-12). Nothing in this section takes a
  password, and no library function in E12-R03/R04 may accept one.

Vectors: `keys-v1.json` `recovery-phrase-*` — entropy → words → entropy, the KEK for a fixed
entropy, twelve words with a single word substituted (checksum fails), and a phrase containing a
word that is not in the list.

### 6.5 The calendar content key (CCK)

- 32 random bytes from the CSPRNG, one per **(calendar, epoch)**. Never derived from a user key,
  a password, a calendar name or a UUID.
- Epoch 1 when a Private calendar is created, sealed to its owner (E13-R01); a rotation that
  removes a member starts epoch N+1 (E13-R05). Old epochs stay readable to members who hold them;
  a removed member keeps what they already downloaded (ADR 0001 § Rotation).
- The CCK opens the event envelopes and the calendar-metadata envelope of its epoch, and nothing
  else.

### 6.6 Sealed, signed CCK record

One record per member per epoch, in `calendar_keys.record`, where the table's `user_id` is the
**recipient**. D-15: a sealed box proves nothing about the sender, so every record is signed with
the sender's Ed25519 identity key.

```
offset  size  field
     0     1  version = 0x01
     1     1  suite: 0x01 = X25519 seal + Ed25519 signature
     2    16  signer user id, raw UUIDv4 bytes
    18    32  crypto_box_seal ephemeral public key
    50    48  crypto_box_seal ciphertext: the 32-byte CCK followed by its 16-byte tag
    98    64  Ed25519 signature by the signer's identity key
               total 162 bytes
```

Sealing:

1. `sealed = crypto_box_seal(cck, recipient_x25519_pk)` — 80 bytes, laid out at 18…97.
2. `sig_msg = "calflex-cck-record-v1" ‖ lp32(calendar_id) ‖ lp32(recipient user id) ‖ lp32(epoch as canonical decimal) ‖ lp32(record[0:98])`
3. `signature = crypto_sign_detached(sig_msg, signer_ed25519_sk)` — at 98…161.

A sealed box draws a fresh ephemeral key on every seal, so a *sealing* vector cannot be
deterministic. The vectors therefore pin the bytes of a box whose ephemeral key was fixed (`epk ‖
crypto_box_easy(cck, nonce = BLAKE2b-256(epk ‖ recipient_pk), recipient_pk, esk)`, which is exactly
what libsodium computes) and expect a library's own `crypto_box_seal_open` to open it; the vector
names the ephemeral key it used, so a library with a test seam can reproduce the record byte for
byte. The same holds for §6.7's bundle.

Opening (a recipient):

1. Length must be exactly 162, version `0x01`, suite `0x01` → else `E_LENGTH` / `E_VERSION` /
   `E_UNSUPPORTED`.
2. Verify the signature over the message above, built from the **caller's own** `user_id` as the
   recipient, the `calendar_id` and the epoch it looked the record up by, and the signer's
   `ed25519_pk` from `user_keys` → else `E_SIGNATURE`. Verification comes first: a moved or
   re-addressed record fails here, and the signature is the only thing that proves D-15's "this
   record came from that user".
3. `cck = crypto_box_seal_open(record[18:98], recipient_x25519_sk, record[18:50])` → `E_AUTH` on
   failure. The plaintext must be exactly 32 bytes → else `E_LENGTH`.

Who signs: the client that creates the calendar (its owner) for epoch 1, and any member that
legitimately seals an epoch to a new member (E13-R05) — the record carries the signer's id for
exactly this reason, because `calendar_keys` has no `signer` column. A recipient **MUST** refuse to
use a CCK from a sender whose identity key it has not verified (D-15; E13-R05 seals only to
**verified** keys). A `record` the API should refuse: shorter than 50 bytes (it cannot hold the
fixed header through the seal's ephemeral key) or longer than **1024**; today's records are exactly
162.

### 6.7 Device linking (E14-R08)

Linking hands the private keys from a device that has them to a new one, sealed to an ephemeral
X25519 key that the new device generates and shows (D-17). The server is a 5-minute, read-once
rendezvous and holds nothing but the sealed blob.

**The QR payload the new device shows** — an ASCII URI, byte mode, error correction M or better:

```
calflex://link/1?l=<link-id>&e=<b64u(32-byte ephemeral X25519 public key)>&c=<6 digits>
```

| Part | Rule |
|---|---|
| version | The path segment `1`. Anything else → `E_VERSION`. |
| `l` | The `device_links` row's UUIDv4, canonical lowercase text. |
| `e` | `b64u`, no padding, exactly 32 bytes decoded → else `E_ENCODING`. |
| `c` | The verification code below, exactly six digits with leading zeros. |
| order | The parameters appear in that order; a repeated or unknown parameter → `E_VERIFY`. |

**The short verification code** is what a human compares on the two screens:

```
digest = SHA-256("calflex-link-code-v1" ‖ ephemeral_pk(32 bytes) ‖ identity_pk(32 bytes))
code   = decimal(int_be(digest[0:8]) mod 1_000_000), zero-padded to 6 digits
```

- `identity_pk` is the user's Ed25519 identity public key: the linking device takes it from its own
  keystore, the new device from `user_keys` (it is signed in, so it can fetch it).
- A malicious server that substituted a different identity key would produce a different code on
  the two screens, which is the whole point of showing one. Six digits is ~20 bits of agreement: a
  human comparison does not need more, the code is checked out of band, and the link expires in
  5 minutes and is single-use. The linking device **MUST** abort with `E_VERIFY` if the code the
  user confirmed does not equal the code it computes, and **MUST NOT** upload a bundle until it
  matches.
- The new device's private keys are wiped and the ephemeral keypair discarded if the link fails.

**The key bundle the linking device uploads** (the `device_links.sealed_blob`):

```
offset  size  field
     0     1  version = 0x01
     1     1  suite = 0x01
     2    16  signer user id, raw UUIDv4 bytes (the linking device's owner)
    18    32  recipient ephemeral X25519 public key (the new device's, raw)
    50    32  crypto_box_seal ephemeral public key
    82   121  crypto_box_seal ciphertext: the 105-byte KeyBundle (§6.2) + 16-byte tag
   203    64  Ed25519 signature by the signing device's identity key
               total 267 bytes
```

```
sig_msg = "calflex-link-bundle-v1" ‖ lp32(user_id) ‖ lp32(link_id)
                                        ‖ lp32(recipient ephemeral pk, 32 raw bytes)
                                        ‖ lp32(bundle[0:203])
```

- `crypto_box_seal` carries no AAD, so the signature is the only binding: it pins the user, the
  rendezvous id, the recipient's ephemeral key and the whole sealed blob, so the server cannot
  replay this blob at a different ephemeral key or a different link.
- The new device: check length/version/suite (`E_LENGTH`/`E_VERSION`/`E_UNSUPPORTED`), verify the
  signature with the signer's `ed25519_pk` from `user_keys` (`E_SIGNATURE`), then
  `crypto_box_seal_open(bundle[50:203], ephemeral_sk, bundle[50:82])` (`E_AUTH`), then validate the
  KeyBundle (`E_LENGTH`/`E_PAYLOAD`, including the check that the keys match the `user_keys` row).
- The bundle contains **both** private keys — the X25519 sealing key and the Ed25519 identity key —
  which is why it is the same TLV as a wrap's plaintext: one parser, one set of checks.

### 6.8 Identity, fingerprints and safety numbers (D-15)

D-15's authenticity comes from comparing a value out of band, either by scanning a QR code in
person or by reading numbers aloud. Three formats:

**Identity fingerprint** — 32 bytes, the SHA-256 over both public keys (so that a substituted
*sealing* key is as visible as a substituted identity key):

```
fingerprint = SHA-256("calflex-id-v1" ‖ x25519_pk(32) ‖ ed25519_pk(32))
```

- Canonical text: 64 lowercase hex digits (§0.2), which is what an invite link carries (E06-R09).
- Display: the 64 digits in eight groups of eight, space-separated, e.g.
  `60570e7d 0a492240 03cfc864 0d7286d3 bef9196f 76721e53 29decb91 22f8f71b`.

**Safety number** — 60 decimal digits, computed identically on both users' devices:

```
d      = SHA-256("calflex-safety-v1" ‖ fp_a(32 bytes) ‖ fp_b(32 bytes))
digits = decimal(int_be(d) mod 10^60), zero-padded to exactly 60 digits
```

- The two fingerprints are ordered by **bytewise ascending comparison of the raw 32 bytes** before
  hashing, so both sides compute the same number whichever one scans first. Two identical
  fingerprints (the same user's two screens) are hashed as the same value twice.
- Display: twelve groups of five digits, single spaces; the UI may break them into lines of four
  groups. The underlying value is the 60-digit string.

**Key-verification QR payload** — what a user shows so the other can mark both keys verified
(E06-R09, D-15):

```
calflex://verify/1?u=<user-id>&k=<b64u(ed25519_pk)>&x=<b64u(x25519_pk)>&f=<fingerprint hex>
```

- `u` canonical lowercase UUIDv4, `k`/`x` exactly 32 bytes `b64u` without padding, `f` the 64-digit
  fingerprint of those two keys.
- The scanner **MUST** recompute the fingerprint from `k` and `x` and refuse with `E_VERIFY` unless
  it equals `f`; a mismatch means the code was assembled by something that does not hold both
  keys. It **MUST** also refuse a repeated or unknown parameter (`E_VERIFY`) and a bad version
  (`E_VERSION`).
- `f` is redundant by construction and is included on purpose: it makes the payload self-checking
  and gives the vectors a clean negative case. With all four parameters the URI is **216** ASCII
  bytes for our UUIDv4 lengths, which needs a version-10 (57×57) QR at error correction M — the
  size to design the screen for.
- Scanning it marks **both** sides verified. The fingerprint alone (an invite link, a message) gives
  the unverified state that E06-R09's UI wording describes.

Any other `calflex://` URI is E06-R09's to shape; it reuses the fingerprint format above verbatim.

---

## 7. Test vectors

`spec/crypto-vectors/` holds the vectors, and `spec/crypto-vectors/gen/` holds the **independent
reference implementation** that generated them: Python 3 plus PyNaCl, with a hand-written JCS
serialiser that is cross-checked against `rfc8785`. It is a separate program from
`packages/crypto_dart` and `packages/crypto-ts`, imports neither, and is never imported by them.
Its job is to be something *other* than the libraries: they are tested against a foreign
implementation of this document, not against themselves.

| File | Contract |
|---|---|
| `envelope-v1.json` | §1: header, seal/open, epoch bounds, truncation, tag and AAD tampering, `X-CALFLEX-ENVELOPE-SHA256` |
| `aad-v1.json` | §2: field order and framing for both kinds, `lp32` boundaries, one wrong field at a time, `RDATE`/`EXDATE` outside the AAD |
| `canonical-timing-v1.json` | §3: the four `DTSTART` forms, `DTEND`/`DURATION`, durations, `RRULE` canonicalisation, the two DST answers |
| `payload-jcs-v1.json` | §4: JCS output for event and calendar payloads, member rules, the forbidden/required sets |
| `metadata-envelope-v1.json` | §1.4 + §4.3: the calendar-metadata envelope, including opening it as an event envelope and the reverse |
| `keys-v1.json` | §6.2–6.4: the KeyBundle, the recovery phrase, the `KEK_rc`, the wrapped private key, its size bounds |
| `cck-records-v1.json` | §6.6: sealing, signing, verification, and the moved-record negatives |
| `device-link-v1.json` | §6.7: the QR payload, the verification code, the key bundle |
| `identity-v1.json` | §6.8: fingerprints, safety numbers, the verification QR payload |

Every file has the shape:

```json
{
  "file": "<name>.json",
  "format": "calflex-crypto-vectors/1",
  "spec": "spec/crypto.md",
  "generator": "spec/crypto-vectors/gen/generate.py",
  "note": "Invented test values. No real key material.",
  "vectors": [
    {
      "id": "envelope-event-open-basic",
      "kind": "positive",
      "spec": "§1.3",
      "purpose": "one line, in the spec's vocabulary",
      "inputs":  { "...": "..." },
      "expected": { "...": "..." }
    }
  ]
}
```

- `kind` is `positive` (the operation succeeds with the stated output) or `negative` (it must be
  refused).
- A negative vector's `expected` is `{"error": "E_…"}` with a code from §0.3. A vector that
  expects an error **MUST NOT** also carry an output — a partial result is a bug, not a
  near-miss.
- `inputs` uses the vocabulary documented in `crypto-vectors/README.md`: `*_hex` for bytes, plain
  strings for text, `*_b64`/`*_b64u` where the encoding is under test.
- Vectors are **deterministic**: every key, nonce and seed is a fixed invented value in the file.
  Where an operation is inherently random (a sealed box, a CSPRNG draw), the vector is one that
  *opens* a fixed blob, or one that pins the derived value, never one that requires the generator
  to reproduce randomness.
- The files are **frozen**. From E12-R03 they are read-only inputs for the libraries; a change to
  one is a spec change and needs the spec's version bump. `packages/crypto_dart` and
  `packages/crypto-ts` therefore must not regenerate them.
- Every wire item in this document appears in a vector: the generator's `VECTOR_INDEX` maps each
  section to its vector ids and fails if one is missing, which is the completeness check E12-R05
  wants at the library end.

Commands (also in `crypto-vectors/gen/README.md`):

```sh
spec/crypto-vectors/gen/generate.sh            # regenerate every vector in place
spec/crypto-vectors/gen/generate.sh --check    # regenerate into a scratch directory and diff
```

`generate.sh` is the one command: it builds a virtual environment outside the worktree
(`$CALFLEX_VECTOR_VENV`, default `~/.cache/flexcalendar-agent-team/e12-crypto-vectors-venv`) from
`gen/requirements.txt`, whose every artefact is pinned by version **and** SHA-256, and then runs
`gen/generate.py`. `--check` regenerates every file into a temporary directory and exits non-zero
if any byte differs from the committed file, so a hand-edited vector or a drifting generator is
caught without a library in the loop. `gen/generate.py` also fails when a vector is not claimed by
the index above, when a `same_as`/`differs_from` claim does not hold, or when a payload's JCS
output disagrees with `rfc8785` (0.1.4, a second implementation, used only as a cross-check).

Each vector names the operation it belongs to in `op` (`seal_event`, `open_event`,
`canonical_timing`, `open_wrapped_key`, `open_cck_record`, `parse_link_uri`, …), which is how a
library test harness maps a file to its entry points. `crypto-vectors/README.md` documents the
input vocabulary (`payload_object`, `payload_text`, `payload_hex`, `skeleton_properties`, the
`*_hex` byte strings) and the `op` values.

---

## 8. What this format does and does not claim

- **The server never decrypts** (INV-07): no content-crypto library is linked under `server/**`,
  and no log line, error message or test snapshot carries a `SUMMARY`, a `DESCRIPTION`, a
  `LOCATION`, an attendee, a payload byte or an envelope byte.
- **No key comes from the login password** (D-17, INV-12). The login password authenticates at the
  IdP and is an input to nothing in this document; no function in the crypto packages takes one.
- **Sealed boxes are anonymous** (D-15). Everything sealed is signed with the sender's identity
  key, and a member verifies a sender's identity key in person or by safety number before trusting
  a CCK record.
- **Timing, recurrence, the number of events and the calendar's existence stay visible** to the
  server, and a removed member keeps what they already downloaded (ADR 0001 § Rotation). The
  format does not pretend otherwise; the product copy is the ADR's claim table.
- **Nonce reuse is catastrophic** and undetectable by a reader (§1.2). Every seal draws a fresh
  24-byte nonce from the device CSPRNG; there is no counter, no stored nonce and no
  caller-supplied nonce in production code.

## 9. Open items for other requirements

These are gaps this spec records rather than fixes, because the writable paths of E12-R01 stop at
`spec/crypto.md` and `spec/crypto-vectors/`:

1. **Event-envelope ceiling.** `MAX_EVENT_ENVELOPE_BYTES = 65536` is a client-side rule here; the
   API checks only the metadata envelope's 4096. A server-side check (or a `CHECK (octet_length(…) <= …)`
   on `event_envelopes`) belongs to E13-R02/E04 if the owner wants one.
2. **TZID spelling.** §3.1 relies on the skeleton's `TZID` being written back unchanged. E05-R07's
   writer and E03-R09's guard should confirm they never normalise a zone name (`Asia/Calcutta` →
   `Asia/Kolkata` would invalidate an envelope).
3. **`device_links` rendezvous id.** §6.7 assumes the row has a UUIDv4 `id`; E04-R02's column list
   does not name it. If it is named something else, only the column name changes, not the value.
4. **Escrow wrap format.** §6.3.2 reserves `kind = 0x02`. E14-R01 (Phase 7) defines that blob and
   the API's size limits; version 1 refuses it.
5. **`records` and wraps at scale.** §6.3.3 and §6.6 name API-side size caps the schema does not
   have. E04-R05/E13-R02 should enforce them where the blobs are accepted.
6. **A JCS library for the libraries.** This spec pins the reference serialiser's behaviour and
   the vectors it produces; which JCS implementation `packages/crypto_dart`/`crypto-ts` use is
   E12-R03's choice, as long as the vectors pass byte-for-byte.
7. **`sodium_libs` in ADR 0001.** The E12-R02 follow-up notes ADR 0001 § Libraries still names
   `sodium_libs`, which is discontinued in favour of `sodium`. That ADR line is the owner's to
   amend, not this spec's.
8. **The recovery-code wrap's primitive.** §6.3 wraps under `KEK_rc` with XChaCha20-Poly1305 rather
   than ADR 0001's `crypto_box_seal`, because a symmetric KEK has no keypair to seal to. The ADR's
   wrapping line is otherwise unchanged.
9. **The recovery code is BIP-0039 proper**, not a "BIP39-style" list: twelve words, a 4-bit
   checksum and the pinned `english.txt`. The checksum is what makes a mistyped word a refusal
   (§6.4) and it is what the negative vectors test.

