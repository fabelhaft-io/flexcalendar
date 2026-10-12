# `spec/crypto-vectors/` — cross-language crypto test vectors

**Owning requirement:** [E12-R01](../../docs/epics/E12-crypto-core.md) ·
**Spec:** [`spec/crypto.md`](../crypto.md) · **Generator:** [`gen/`](gen/README.md) ·
**Owning epic:** [E12 — Crypto core and shared test vectors](../../docs/epics/E12-crypto-core.md).

- **What belongs here:** the positive and negative test vectors (JSON) for the envelope, the
  canonical AAD, the timing bindings, the payload, the calendar-metadata envelope and the key
  hierarchy defined in `spec/crypto.md`. They are written once in Phase 2 and then **frozen**, and
  the TypeScript library in Phase 5 is held to them
  ([`docs/04-implementation-phases.md`](../../docs/04-implementation-phases.md)).
- Run by [`packages/crypto_dart`](../../packages/crypto_dart/README.md) from Phase 2 and by both
  libraries from Phase 5; [E12-R05](../../docs/epics/E12-crypto-core.md) wires them into
  `make verify` and fails the build when `spec/crypto.md` gains a field without a vector. Both
  libraries must produce byte-identical output.
- **Generated, never hand-edited:** every `*.json` here comes from
  [`gen/generate.py`](gen/README.md), which is an independent reference implementation (Python 3 +
  PyNaCl) that imports neither library.
  `spec/crypto-vectors/gen/generate.sh --check` regenerates them into a scratch directory and
  exits non-zero if a single byte differs, so a hand-edit or a drift in the generator is caught
  without a library in the loop. A change to a vector is a change to `spec/crypto.md`.
- **Invented values only:** every key, seed, nonce, phrase, calendar and event content here is a
  test value. No real key material, no real phrase, no real event. Nothing here is a secret.

## Files

| File | Spec | Contents |
|---|---|---|
| `envelope-v1.json` | §1, §5.1 | Header layout, seal/open, epoch bounds, truncation, tag/ciphertext/nonce tampering, the AAD fields one at a time, `X-CALFLEX-ENVELOPE-SHA256` |
| `aad-v1.json` | §2 | Both AAD kinds, field order and `lp32` framing, one wrong field at a time, `RDATE`/`EXDATE` outside the AAD |
| `canonical-timing-v1.json` | §3, §5.2 | The four `DTSTART` forms, `DTEND`/`DURATION`, duration and `RRULE` canonicalisation, the DST answers, the canonical `recurrence_id` |
| `payload-jcs-v1.json` | §4 | JCS output, the event and calendar member rules, the required/forbidden sets |
| `metadata-envelope-v1.json` | §1.4, §4.3 | The calendar-metadata envelope, including opening it as an event envelope and the reverse (D-18) |
| `keys-v1.json` | §6.1–§6.4 | The KeyBundle, the recovery phrase and its checksum, `KEK_rc`, the wrapped private key and its size bounds |
| `cck-records-v1.json` | §6.6 | Sealing, signing, verification, and the moved-record negatives |
| `device-link-v1.json` | §6.7 | The link QR payload, the six-digit verification code, the sealed key bundle |
| `identity-v1.json` | §6.8 | Fingerprints, safety numbers, the key-verification QR payload |

## Shape of a vector

```json
{
  "file": "aad-v1.json",
  "format": "calflex-crypto-vectors/1",
  "spec": "spec/crypto.md",
  "generator": "spec/crypto-vectors/gen/generate.py",
  "note": "Invented test values only. No real key material, calendar or event content.",
  "vectors": [
    {
      "id": "aad-event-master",
      "kind": "positive",
      "op": "build_aad",
      "spec": "§2.2",
      "purpose": "one line, in the spec's vocabulary",
      "inputs":  { "...": "..." },
      "expected": { "...": "..." }
    }
  ]
}
```

- `kind` is `positive` (the operation succeeds with the stated output) or `negative` (it must be
  refused). A negative vector's `expected` is exactly `{"error": "E_…"}` with a code from
  `spec/crypto.md` §0.3 — a partial result where an error is expected is a bug, not a near miss.
- `op` names the entry point the vector exercises, so a test harness can map a file to functions:
  `seal_event`, `open_event`, `skeleton_hash`, `build_aad`, `canonical_timing`, `jcs_dumps`,
  `validate_payload`, `seal_metadata`, `open_metadata`, `recovery_phrase`, `parse_recovery_phrase`,
  `recovery_kek`, `key_bundle`, `check_key_bundle`, `identity_keys`, `seal_wrapped_key`,
  `open_wrapped_key`, `seal_cck_record`, `open_cck_record`, `link_code`, `link_uri`,
  `parse_link_uri`, `seal_link_bundle`, `open_link_bundle`, `fingerprint`, `safety_number`,
  `verify_uri`, `parse_verify_uri`, `constants`.
  (`constants` marks a vector that pins a literal — a label, a byte offset, an index.)
- `same_as` / `differs_from` (top level, optional) name another vector **in the same file** whose
  primary output must be equal or different. The generator verifies both claims when it builds the
  file, so they cannot rot.

### Input vocabulary

| Key | Meaning |
|---|---|
| `*_hex` | A byte string as lowercase hex. |
| `calendar_id`, `uid`, `user_id`, `recipient_user_id`, `link_id` | Text identifiers (lowercase UUIDv4 where the spec says so). |
| `epoch` | An integer epoch, as the API's `metaEpoch`/`epoch` is. |
| `skeleton_properties` | The skeleton as a list of iCalendar content lines (`NAME;PARAM=…:VALUE`), which is what a parser is handed. |
| `dtstart`, `end`, `rrule`, `recurrence_id` | Canonical AAD field values (§2.2, §3) — the shape the AAD builder takes. |
| `payload_object` | A JSON object to serialise with JCS (§4.1) |
| `payload_text` | Raw UTF-8 payload bytes as a JSON string, for vectors a JSON *object* cannot express (a duplicate member name, a member order that is valid JSON but not JCS). |
| `payload_hex` | Raw payload bytes as hex, for a payload that is not valid UTF-8. |
| `payload_kind` | `event` or `calendar`: which §4 rule set to validate against. |
| `crypto_box_seal` inputs | A sealed box is random by construction, so a vector that pins one gives a box whose ephemeral key was fixed; a library opens it with `crypto_box_seal_open` (`gen/README.md` § Determinism). |

Field names in `expected` are the spec's: `aad_hex` (the exact AAD bytes), `envelope_hex`,
`envelope_bytes`, `envelope_sha256_hex`, `payload_jcs`, `signature_message_hex` (the byte string a
signature covers), `seal_ephemeral_pk_hex` and `seal_nonce_hex` (the fixed ephemeral key of a
pinned sealed box and the 24-byte BLAKE2b nonce it derives, pinning §6.6's seal nonce),
`fingerprint_hex`, `safety_number`, `uri`, and `error` for a refusal.

## What a reader must refuse

The negative vectors cover, with the code each must produce: a wrong envelope version, a truncated
or oversized envelope, an epoch above `2 147 483 647`, a flipped tag, ciphertext or nonce byte, a
wrong CCK, each AAD field changed in turn, a non-canonical encoding (uppercase hex, padded
base64url, a non-canonical UUID, a leading zero), a payload that is valid JSON but not JCS, a
forbidden, duplicate, `null` or float member, a calendar-metadata envelope opened as an event
envelope and the reverse, a CCK record whose signature fails or that was moved between calendars,
epochs or recipients, a device-link bundle replayed at another link or ephemeral key, a recovery
phrase with a bad checksum or an unknown word, a fingerprint that does not cover the keys it is
attached to, and a verification code that does not match them.
