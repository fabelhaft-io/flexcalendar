#!/usr/bin/env python3
"""Reference implementation of `spec/crypto.md` and generator of its test vectors (E12-R01).

This program is deliberately **not** one of the libraries. It is Python 3 with PyNaCl, it reads
`spec/crypto.md`, it writes `spec/crypto-vectors/*.json`, and it never imports, shells out to or
copies from `packages/crypto_dart` or `packages/crypto-ts` (which it predates). The libraries are
tested against a foreign implementation of the same document, not against themselves.

    python generate.py            regenerate the vectors in place
    python generate.py --check    regenerate into a scratch directory and diff

`--check` is the freeze check: the vectors are inputs once E12-R03 passes, so a hand-edit or a
drifting generator has to fail loudly.

Everything here is invented test material. No real key, nonce, phrase or calendar appears.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import jcs
from nacl import bindings
from nacl.exceptions import BadSignatureError, CryptoError

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent
SPEC = "spec/crypto.md"
VECTORS_FORMAT = "calflex-crypto-vectors/1"
NOTE = "Invented test values only. No real key material, calendar or event content."

# --------------------------------------------------------------------------------------------
# Constants from spec/crypto.md, named there and checked here.
# --------------------------------------------------------------------------------------------

LABEL_EVENT = b"calflex-v1"
LABEL_META = b"calflex-meta-v1"
LABEL_KEYWRAP = b"calflex-keywrap-v1"
LABEL_CCK_RECORD = b"calflex-cck-record-v1"
LABEL_LINK_BUNDLE = b"calflex-link-bundle-v1"
LABEL_ID = b"calflex-id-v1"
LABEL_SAFETY = b"calflex-safety-v1"
LABEL_LINK_CODE = b"calflex-link-code-v1"

HKDF_SALT = b"calflex-v1"
HKDF_INFO_RECOVERY_KEK = b"calflex-v1/recovery-kek"

ENVELOPE_VERSION = 0x01
ENVELOPE_FIXED_BYTES = 45
MAX_EPOCH = 2**31 - 1
MAX_META_ENVELOPE_BYTES = 4096
MAX_EVENT_ENVELOPE_BYTES = 65536
MAX_WRAPPED_KEY_BYTES = 512
MIN_WRAPPED_KEY_BYTES = 42
MAX_CCK_RECORD_BYTES = 1024

WRAP_KIND_CODES = {"recovery_code": 0x01, "escrow": 0x02}
KEY_BUNDLE_LENGTH = 105
CCK_RECORD_LENGTH = 162
LINK_BUNDLE_LENGTH = 267
SUITE_KEYWRAP = "x25519-ed25519-v1"

# --------------------------------------------------------------------------------------------
# Fixed, invented test material.
# --------------------------------------------------------------------------------------------

TEST_CCK = bytes(range(0x20))
TEST_NONCE = bytes(range(0x20, 0x38))
TEST_KEK_SOURCE = bytes([0x5A]) * 16

CALENDAR_ID = "11111111-1111-4111-8111-111111111111"
USER_A = "22222222-2222-4222-8222-222222222222"
USER_B = "33333333-3333-4333-8333-333333333333"
USER_C = "66666666-6666-4666-8666-666666666666"
LINK_ID = "44444444-4444-4444-8444-444444444444"
EVENT_UID = "55555555-5555-4555-8555-555555555555"

A_X25519_SEED = bytes([0x11]) * 32
A_ED25519_SEED = bytes([0x22]) * 32
B_X25519_SEED = bytes([0x33]) * 32
B_ED25519_SEED = bytes([0x44]) * 32
C_X25519_SEED = bytes([0x55]) * 32
C_ED25519_SEED = bytes([0x88]) * 32
EPHEMERAL_SEED = bytes([0x66]) * 32
SEAL_EPHEMERAL_SEED = bytes([0xCC]) * 32
LINK_SEAL_EPHEMERAL_SEED = bytes([0xDD]) * 32

BASIC_SKELETON = [
    "UID:" + EVENT_UID,
    "DTSTART;TZID=Europe/Berlin:20260401T110000",
    "DTEND;TZID=Europe/Berlin:20260401T120000",
]
BASIC_RECURRENCE_ID = ""

EVENT_PAYLOAD = {
    "@type": "Event",
    "title": "Physio (test value)",
    "description": 'Invented test content \u2014 "quoted" \\ backslash, line\nbreak, Gr\u00fc\u00dfe \U0001f642',
    "descriptionContentType": "text/plain",
    "keywords": {"test": True},
    "locations": {"park": {"name": "Praxis am Park (test value)"}},
    "participants": {
        "alice@example.test": {
            "email": "alice@example.test",
            "name": "Alice (test value)",
            "roles": {"attendee": True},
        }
    },
    "priority": 5,
}
CALENDAR_PAYLOAD = {
    "@type": "Calendar",
    "color": "#3b82f6",
    "name": "Privat (test value)",
}

# BIP-0039's own reference vectors, from the reference implementation's `vectors.json`
# (https://github.com/trezor/python-mnemonic/blob/master/vectors.json), quoted here so the pinned
# word list and the checksum rule are checked without a network call.
BIP39_VECTORS = [
    (
        "00000000000000000000000000000000",
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    ),
    (
        "80808080808080808080808080808080",
        "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
    ),
]

# --------------------------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------------------------


class Refused(Exception):
    """A refusal with a code from spec/crypto.md §0.3."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# --------------------------------------------------------------------------------------------
# Framing, hashes, KDF
# --------------------------------------------------------------------------------------------


def lp32(value: bytes) -> bytes:
    return len(value).to_bytes(4, "big") + value


def framed(label: bytes, fields: list[bytes]) -> bytes:
    return label + b"".join(lp32(field) for field in fields)


def u32(value: int) -> bytes:
    return value.to_bytes(4, "big")


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    """RFC 5869 extract-then-expand with SHA-256."""
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    okm = b""
    block = b""
    counter = 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


def uuid_bytes(text: str) -> bytes:
    value = text.replace("-", "")
    if len(value) != 32:
        raise Refused("E_ENCODING")
    return bytes.fromhex(value)


def check_uuid_v4(text: str) -> None:
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", text
    ):
        raise Refused("E_ENCODING")


# --------------------------------------------------------------------------------------------
# iCalendar parsing, limited to what the skeleton carries
# --------------------------------------------------------------------------------------------

WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
RRULE_ORDER = [
    "FREQ",
    "UNTIL",
    "COUNT",
    "INTERVAL",
    "BYSECOND",
    "BYMINUTE",
    "BYHOUR",
    "BYDAY",
    "BYMONTHDAY",
    "BYYEARDAY",
    "BYWEEKNO",
    "BYMONTH",
    "BYSETPOS",
    "WKST",
]
RRULE_RANGES = {
    "BYSECOND": (0, 60, False),
    "BYMINUTE": (0, 59, False),
    "BYHOUR": (0, 23, False),
    "BYMONTHDAY": (1, 31, True),
    "BYYEARDAY": (1, 366, True),
    "BYWEEKNO": (1, 53, True),
    "BYMONTH": (1, 12, False),
    "BYSETPOS": (1, 366, True),
}


def parse_property(line: str) -> tuple[str, dict[str, str], str]:
    head, sep, value = line.partition(":")
    if not sep:
        raise Refused("E_SKELETON")
    pieces = head.split(";")
    name = pieces[0].upper()
    if not name:
        raise Refused("E_SKELETON")
    params: dict[str, str] = {}
    for piece in pieces[1:]:
        key, eq, param = piece.partition("=")
        if not eq or not key:
            raise Refused("E_SKELETON")
        key = key.upper()
        if key in params:
            raise Refused("E_SKELETON")
        params[key] = param
    return name, params, value


def _check_date(value: str) -> str:
    if not re.fullmatch(r"\d{8}", value):
        raise Refused("E_SKELETON")
    try:
        datetime.strptime(value, "%Y%m%d")
    except ValueError:
        raise Refused("E_SKELETON") from None
    return value


def _check_local(value: str) -> str:
    if not re.fullmatch(r"\d{8}T\d{6}", value):
        raise Refused("E_SKELETON")
    if value[13:15] == "60":
        # A leap second has no representation in this format (spec §3.1).
        raise Refused("E_UNSUPPORTED")
    try:
        datetime.strptime(value, "%Y%m%dT%H%M%S")
    except ValueError:
        raise Refused("E_SKELETON") from None
    return value


def _check_instant(value: str) -> str:
    if not value.endswith("Z"):
        raise Refused("E_SKELETON")
    return _check_local(value[:-1]) + "Z"


def canonical_time_field(name: str, params: dict[str, str], value: str) -> str:
    """Field 5/6 of the AAD (spec/crypto.md §3.1, §3.2)."""
    if params.get("VALUE", "").upper() == "DATE":
        return "date:" + _check_date(value)
    if "TZID" in params:
        if value.endswith("Z"):
            raise Refused("E_SKELETON")
        tzid = params["TZID"]
        if not tzid or "@" in tzid or ":" in tzid:
            raise Refused("E_SKELETON")
        return "zoned:" + tzid + "@" + _check_local(value)
    if value.endswith("Z"):
        return "utc:" + _check_instant(value)
    if params.get("VALUE", "").upper() == "DATE-TIME":
        raise Refused("E_UNSUPPORTED")  # floating, INV-04
    raise Refused("E_UNSUPPORTED")


def instant_of_time_field(field: str, fold: int = 0) -> str | None:
    """The UTC instant of a canonical timing field, or None for a DATE.

    `fold=0` is PEP 495's "before the gap" for a nonexistent local time and the first occurrence
    for a repeated one — which is RFC 5545 §3.3.5's answer, the one spec/crypto.md §3.4 binds.
    """
    if field.startswith("date:"):
        return None
    if field.startswith("utc:"):
        return field[4:]
    tzid, _, local = field[len("zoned:") :].partition("@")
    naive = datetime.strptime(local, "%Y%m%dT%H%M%S")
    zoned = naive.replace(tzinfo=ZoneInfo(tzid), fold=fold)
    return zoned.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


_DURATION_TIME = re.compile(r"^(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$")


def canonical_duration(text: str) -> str:
    """Spec/crypto.md §3.2.1: components as parsed, no carrying, no leading '+', 'PT0S' for zero."""
    value = text
    sign = ""
    if value.startswith("+"):
        value = value[1:]
    elif value.startswith("-"):
        sign = "-"
        value = value[1:]
    if not value.startswith("P"):
        raise Refused("E_SKELETON")
    body = value[1:]
    if not body:
        raise Refused("E_SKELETON")
    weeks = days = hours = minutes = seconds = 0
    if body.endswith("W"):
        digits = body[:-1]
        if not digits.isdigit():
            raise Refused("E_SKELETON")
        weeks = int(digits)
    else:
        date_part, has_t, time_part = body.partition("T")
        if date_part:
            if not date_part.endswith("D"):
                raise Refused("E_SKELETON")
            digits = date_part[:-1]
            if not digits.isdigit():
                raise Refused("E_SKELETON")
            days = int(digits)
        elif not has_t:
            raise Refused("E_SKELETON")
        if has_t:
            match = _DURATION_TIME.fullmatch(time_part)
            if match is None or not any(match.groups()):
                raise Refused("E_SKELETON")
            hours = int(match.group(1) or 0)
            minutes = int(match.group(2) or 0)
            seconds = int(match.group(3) or 0)
    if weeks:
        return f"{sign}P{weeks}W"
    if hours == 0 and minutes == 0 and seconds == 0 and days == 0:
        return "PT0S"
    out = sign + "P"
    if days:
        out += f"{days}D"
    if hours or minutes or seconds:
        out += "T"
        if hours:
            out += f"{hours}H"
        if minutes:
            out += f"{minutes}M"
        if seconds:
            out += f"{seconds}S"
    return out


def canonical_rrule(text: str) -> str:
    """Spec/crypto.md §3.3."""
    parts: dict[str, str] = {}
    for chunk in text.split(";"):
        name, eq, value = chunk.partition("=")
        name = name.upper()
        if not eq or not value:
            raise Refused("E_SKELETON")
        if name not in RRULE_ORDER:
            raise Refused("E_UNSUPPORTED")
        if name in parts:
            raise Refused("E_SKELETON")
        parts[name] = value
    if "FREQ" not in parts:
        raise Refused("E_SKELETON")
    if "UNTIL" in parts and "COUNT" in parts:
        raise Refused("E_SKELETON")
    out: list[str] = []
    for name in RRULE_ORDER:
        if name not in parts:
            continue
        value = parts[name]
        if name == "FREQ":
            freq = value.upper()
            if freq not in {
                "SECONDLY",
                "MINUTELY",
                "HOURLY",
                "DAILY",
                "WEEKLY",
                "MONTHLY",
                "YEARLY",
            }:
                raise Refused("E_SKELETON")
            out.append("FREQ=" + freq)
        elif name == "UNTIL":
            if re.fullmatch(r"\d{8}", value):
                out.append("UNTIL=" + _check_date(value))
            else:
                out.append("UNTIL=" + _check_instant(value.upper()))
        elif name in ("COUNT", "INTERVAL"):
            if not re.fullmatch(r"\d+", value):
                raise Refused("E_SKELETON")
            number = int(value)
            if number < 1:
                raise Refused("E_SKELETON")
            if name == "INTERVAL" and number == 1:
                continue  # the RFC's default
            out.append(f"{name}={number}")
        elif name == "BYDAY":
            entries: set[tuple[int, int]] = set()
            for entry in value.split(","):
                match = re.fullmatch(r"([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)", entry.upper())
                if match is None:
                    raise Refused("E_SKELETON")
                weekday = WEEKDAYS.index(match.group(2))
                ordinal = int(match.group(1)) if match.group(1) else 0
                if ordinal and abs(ordinal) > 53:
                    raise Refused("E_SKELETON")
                entries.add((weekday, ordinal))
            ordered = sorted(entries)
            out.append(
                "BYDAY="
                + ",".join(
                    (str(ordinal) if ordinal else "") + WEEKDAYS[weekday]
                    for weekday, ordinal in ordered
                )
            )
        elif name == "WKST":
            day = value.upper()
            if day not in WEEKDAYS:
                raise Refused("E_SKELETON")
            if day != "MO":
                out.append("WKST=" + day)
        else:
            low, high, signed = RRULE_RANGES[name]
            numbers: set[int] = set()
            for entry in value.split(","):
                if not re.fullmatch(r"[+-]?\d+", entry):
                    raise Refused("E_SKELETON")
                number = int(entry)
                if signed:
                    in_range = low <= abs(number) <= high
                else:
                    in_range = low <= number <= high
                if not in_range:
                    raise Refused("E_SKELETON")
                numbers.add(number)
            out.append(name + "=" + ",".join(str(number) for number in sorted(numbers)))
    return ";".join(out)


def canonical_recurrence_id(properties: dict[str, str]) -> str:
    """Spec/crypto.md §5.2 / E04-R04."""
    if "RECURRENCE-ID" not in properties:
        return ""
    name, params, value = parse_property(properties["RECURRENCE-ID"])
    if name != "RECURRENCE-ID":
        raise Refused("E_SKELETON")
    field = canonical_time_field(name, params, value)
    if field.startswith("date:"):
        return field[len("date:") :]
    instant = instant_of_time_field(field)
    assert instant is not None
    return instant


def timing_fields(lines: list[str]) -> dict[str, str]:
    """The AAD's timing fields (and the canonical recurrence_id) from skeleton content lines."""
    properties: dict[str, str] = {}
    for line in lines:
        name, _, _ = parse_property(line)
        if name in properties:
            raise Refused("E_SKELETON")
        properties[name] = line
    if "DTSTART" not in properties:
        raise Refused("E_SKELETON")
    _, params, value = parse_property(properties["DTSTART"])
    fields = {"dtstart": canonical_time_field("DTSTART", params, value)}
    if "DTEND" in properties and "DURATION" in properties:
        raise Refused("E_SKELETON")
    if "DTEND" in properties:
        _, params, value = parse_property(properties["DTEND"])
        fields["end"] = canonical_time_field("DTEND", params, value)
    elif "DURATION" in properties:
        _, _, value = parse_property(properties["DURATION"])
        fields["end"] = "dur:" + canonical_duration(value)
    else:
        fields["end"] = "none"
    if "RRULE" in properties:
        _, _, value = parse_property(properties["RRULE"])
        fields["rrule"] = "rrule:" + canonical_rrule(value)
    else:
        fields["rrule"] = "none"
    fields["recurrence_id"] = canonical_recurrence_id(properties)
    return fields


# --------------------------------------------------------------------------------------------
# AADs and envelopes
# --------------------------------------------------------------------------------------------


def aad_event(
    calendar_id: str,
    uid: str,
    recurrence_id: str,
    epoch: int,
    fields: dict[str, str],
) -> bytes:
    check_uuid_v4(calendar_id)
    if not uid:
        raise Refused("E_SKELETON")
    if not 0 <= epoch <= MAX_EPOCH:
        raise Refused("E_EPOCH")
    return framed(
        LABEL_EVENT,
        [
            calendar_id.encode(),
            uid.encode(),
            recurrence_id.encode(),
            str(epoch).encode(),
            fields["dtstart"].encode(),
            fields["end"].encode(),
            fields["rrule"].encode(),
        ],
    )


def aad_meta(calendar_id: str, epoch: int) -> bytes:
    check_uuid_v4(calendar_id)
    if not 0 <= epoch <= MAX_EPOCH:
        raise Refused("E_EPOCH")
    return framed(LABEL_META, [calendar_id.encode(), str(epoch).encode()])


def aad_keywrap(user_id: str, kind: str) -> bytes:
    check_uuid_v4(user_id)
    if kind not in WRAP_KIND_CODES:
        raise Refused("E_ENCODING")
    return framed(LABEL_KEYWRAP, [user_id.encode(), kind.encode(), SUITE_KEYWRAP.encode()])


def seal_envelope(key: bytes, epoch: int, nonce: bytes, aad: bytes, payload: bytes, ceiling: int) -> bytes:
    if not 0 <= epoch <= MAX_EPOCH:
        raise Refused("E_EPOCH")
    if len(key) != 32:
        raise Refused("E_LENGTH")
    if len(nonce) != 24:
        raise Refused("E_LENGTH")
    header = bytes([ENVELOPE_VERSION]) + u32(epoch) + nonce
    blob = header + bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(payload, aad, nonce, key)
    if len(blob) > ceiling:
        raise Refused("E_LENGTH")
    return blob


def open_envelope(key: bytes, blob: bytes, aad: bytes, ceiling: int) -> bytes:
    if len(blob) < ENVELOPE_FIXED_BYTES or len(blob) > ceiling:
        raise Refused("E_LENGTH")
    if blob[0] != ENVELOPE_VERSION:
        raise Refused("E_VERSION")
    if int.from_bytes(blob[1:5], "big") > MAX_EPOCH:
        raise Refused("E_EPOCH")
    try:
        return bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
            blob[29:], aad, blob[5:29], key
        )
    except CryptoError:
        raise Refused("E_AUTH") from None


# --------------------------------------------------------------------------------------------
# BIP-0039 recovery phrase (spec/crypto.md §6.4)
# --------------------------------------------------------------------------------------------

WORDLIST_PATH = HERE / "english.txt"
WORDLIST_BYTES = WORDLIST_PATH.read_bytes()
WORDLIST_SHA256 = sha256(WORDLIST_BYTES).hex()
PINNED_WORDLIST_SHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
if WORDLIST_SHA256 != PINNED_WORDLIST_SHA256:
    raise SystemExit(
        f"english.txt is not the pinned BIP-0039 list: {WORDLIST_SHA256}"
    )
_WORD_LINES = WORDLIST_BYTES.decode("ascii").split("\n")
if len(_WORD_LINES) != 2049 or _WORD_LINES[-1] != "" or len(set(_WORD_LINES[:2048])) != 2048:
    raise SystemExit("english.txt is not 2048 newline-terminated words")
WORDS = _WORD_LINES[:2048]


def recovery_phrase(entropy: bytes) -> str:
    if len(entropy) != 16:
        raise Refused("E_RECOVERY")
    bits = "".join(f"{byte:08b}" for byte in entropy)
    bits += "".join(f"{byte:08b}" for byte in sha256(entropy))[:4]
    return " ".join(WORDS[int(bits[index : index + 11], 2)] for index in range(0, 132, 11))


def parse_recovery_phrase(phrase: str) -> bytes:
    words = [word for word in re.split("[\u0020\u3000]+", phrase.strip().lower()) if word]
    if len(words) != 12:
        raise Refused("E_RECOVERY")
    try:
        indices = [WORDS.index(word) for word in words]
    except ValueError:
        raise Refused("E_RECOVERY") from None
    bits = "".join(f"{index:011b}" for index in indices)
    entropy = int(bits[:128], 2).to_bytes(16, "big")
    expected = "".join(f"{byte:08b}" for byte in sha256(entropy))[:4]
    if bits[128:] != expected:
        raise Refused("E_RECOVERY")
    return entropy


def recovery_kek(entropy: bytes) -> bytes:
    return hkdf_sha256(entropy, HKDF_SALT, HKDF_INFO_RECOVERY_KEK, 32)


# --------------------------------------------------------------------------------------------
# Key material, bundles and blobs (spec/crypto.md §6.1 – §6.3, §6.6, §6.7, §6.8)
# --------------------------------------------------------------------------------------------


def sign_detached(message: bytes, ed25519_sk: bytes) -> bytes:
    """The 64-byte Ed25519 signature, as `crypto_sign_detached` would return it."""
    if len(ed25519_sk) != 64:
        raise Refused("E_LENGTH")
    return bindings.crypto_sign(message, ed25519_sk)[: bindings.crypto_sign_BYTES]


def verify_detached(signature: bytes, message: bytes, ed25519_pk: bytes) -> None:
    if len(signature) != bindings.crypto_sign_BYTES or len(ed25519_pk) != 32:
        raise Refused("E_LENGTH")
    try:
        bindings.crypto_sign_open(signature + message, ed25519_pk)
    except (BadSignatureError, CryptoError):
        raise Refused("E_SIGNATURE") from None


def seal_box(message: bytes, recipient_pk: bytes, ephemeral_sk: bytes) -> bytes:
    """`crypto_box_seal` with the ephemeral key fixed, so a vector can pin the bytes.

    libsodium's sealed box is `epk \u2016 crypto_box_easy(m, nonce = BLAKE2b(epk \u2016 pk), pk, esk)`
    with a fresh random `esk`. A *sealing* path is random by construction, so the vectors pin one
    that a library's own `crypto_box_seal_open` must accept (see `self_checks`), and the vectors
    that seal name the ephemeral key they used.
    """
    import hashlib

    ephemeral_pk = bindings.crypto_scalarmult_base(ephemeral_sk)
    nonce = hashlib.blake2b(ephemeral_pk + recipient_pk, digest_size=24).digest()
    key = bindings.crypto_box_beforenm(recipient_pk, ephemeral_sk)
    return ephemeral_pk + bindings.crypto_secretbox_easy(message, nonce, key)


def key_bundle(x25519_sk: bytes, ed25519_sk: bytes) -> bytes:
    if len(x25519_sk) != 32 or len(ed25519_sk) != 64:
        raise Refused("E_LENGTH")
    return b"\x01" + lp32(x25519_sk) + lp32(ed25519_sk)


def parse_key_bundle(blob: bytes) -> tuple[bytes, bytes]:
    if len(blob) < 1 or blob[0] != 0x01:
        raise Refused("E_VERSION")
    cursor = 1
    fields = []
    for expected_length in (32, 64):
        if len(blob) < cursor + 4:
            raise Refused("E_LENGTH")
        length = int.from_bytes(blob[cursor : cursor + 4], "big")
        cursor += 4
        if length != expected_length:
            raise Refused("E_LENGTH")
        if len(blob) < cursor + length:
            raise Refused("E_LENGTH")
        fields.append(blob[cursor : cursor + length])
        cursor += length
    if cursor != len(blob):
        raise Refused("E_LENGTH")
    return fields[0], fields[1]


def check_key_bundle_matches(blob: bytes, x25519_pk: bytes, ed25519_pk: bytes) -> None:
    x25519_sk, ed25519_sk = parse_key_bundle(blob)
    if (
        bindings.crypto_scalarmult_base(x25519_sk) != x25519_pk
        or ed25519_sk[32:64] != ed25519_pk
    ):
        raise Refused("E_PAYLOAD")


def seal_wrapped_key(kek: bytes, user_id: str, kind: str, nonce: bytes, bundle: bytes) -> bytes:
    aad = aad_keywrap(user_id, kind)
    if len(nonce) != 24:
        raise Refused("E_LENGTH")
    ciphertext = bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(bundle, aad, nonce, kek)
    return bytes([0x01, WRAP_KIND_CODES[kind]]) + nonce + ciphertext


def open_wrapped_key(kek: bytes, user_id: str, kind: str, blob: bytes) -> bytes:
    if not MIN_WRAPPED_KEY_BYTES <= len(blob) <= MAX_WRAPPED_KEY_BYTES:
        raise Refused("E_LENGTH")
    if blob[0] != 0x01:
        raise Refused("E_VERSION")
    if blob[1] == WRAP_KIND_CODES["escrow"]:
        raise Refused("E_UNSUPPORTED")
    if blob[1] != WRAP_KIND_CODES[kind]:
        raise Refused("E_VERSION")
    aad = aad_keywrap(user_id, kind)
    try:
        return bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
            blob[26:], aad, blob[2:26], kek
        )
    except CryptoError:
        raise Refused("E_AUTH") from None


def cck_record_message(
    calendar_id: str, recipient_user_id: str, epoch: int, head: bytes
) -> bytes:
    return framed(
        LABEL_CCK_RECORD,
        [
            calendar_id.encode(),
            recipient_user_id.encode(),
            str(epoch).encode(),
            head,
        ],
    )


def seal_cck_record(
    cck: bytes,
    calendar_id: str,
    epoch: int,
    recipient_user_id: str,
    recipient_x25519_pk: bytes,
    signer_user_id: str,
    signer_ed25519_sk: bytes,
) -> bytes:
    sealed = seal_box(cck, recipient_x25519_pk, SEAL_EPHEMERAL_SEED)
    head = bytes([0x01, 0x01]) + uuid_bytes(signer_user_id) + sealed
    message = cck_record_message(calendar_id, recipient_user_id, epoch, head)
    return head + sign_detached(message, signer_ed25519_sk)


def open_cck_record(
    blob: bytes,
    calendar_id: str,
    epoch: int,
    recipient_user_id: str,
    recipient_x25519_sk: bytes,
    signer_ed25519_pk: bytes,
) -> bytes:
    if len(blob) != CCK_RECORD_LENGTH:
        raise Refused("E_LENGTH")
    if blob[0] != 0x01:
        raise Refused("E_VERSION")
    if blob[1] != 0x01:
        raise Refused("E_UNSUPPORTED")
    message = cck_record_message(calendar_id, recipient_user_id, epoch, blob[0:98])
    verify_detached(blob[98:162], message, signer_ed25519_pk)
    try:
        cck = bindings.crypto_box_seal_open(blob[18:98], recipient_x25519_sk, blob[18:50])
    except CryptoError:
        raise Refused("E_AUTH") from None
    if len(cck) != 32:
        raise Refused("E_LENGTH")
    return cck


def link_code(ephemeral_pk: bytes, identity_pk: bytes) -> str:
    digest = sha256(LABEL_LINK_CODE + ephemeral_pk + identity_pk)
    return str(int.from_bytes(digest[:8], "big") % 1_000_000).zfill(6)


def link_uri(link_id: str, ephemeral_pk: bytes, code: str) -> str:
    check_uuid_v4(link_id)
    if len(ephemeral_pk) != 32 or not re.fullmatch(r"\d{6}", code):
        raise Refused("E_ENCODING")
    return (
        "calflex://link/1?l=" + link_id + "&e=" + b64u_encode(ephemeral_pk) + "&c=" + code
    )


def b64u_encode(value: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def b64u_decode(value: str) -> bytes:
    import base64
    import binascii

    if not re.fullmatch(r"[A-Za-z0-9_-]*", value) or len(value) % 4 == 1:
        raise Refused("E_ENCODING")
    padding = "=" * (-len(value) % 4)
    try:
        decoded = base64.urlsafe_b64decode(value + padding)
    except (ValueError, binascii.Error):
        raise Refused("E_ENCODING") from None
    if b64u_encode(decoded) != value:
        raise Refused("E_ENCODING")
    return decoded


def parse_link_uri(uri: str) -> dict[str, str]:
    prefix = "calflex://link/1?"
    if not uri.startswith("calflex://link/"):
        raise Refused("E_VERSION")
    if not uri.startswith(prefix):
        raise Refused("E_VERSION")
    parts: dict[str, str] = {}
    for chunk in uri[len(prefix) :].split("&"):
        key, eq, value = chunk.partition("=")
        if not eq or key in parts or key not in ("l", "e", "c"):
            raise Refused("E_VERIFY")
        parts[key] = value
    if list(parts) != ["l", "e", "c"]:
        raise Refused("E_VERIFY")
    check_uuid_v4(parts["l"])
    if len(b64u_decode(parts["e"])) != 32 or not re.fullmatch(r"\d{6}", parts["c"]):
        raise Refused("E_ENCODING")
    return parts


def link_bundle_message(
    user_id: str, link_id: str, recipient_ephemeral_pk: bytes, head: bytes
) -> bytes:
    return framed(
        LABEL_LINK_BUNDLE,
        [
            user_id.encode(),
            link_id.encode(),
            recipient_ephemeral_pk,
            head,
        ],
    )


def seal_link_bundle(
    user_id: str,
    link_id: str,
    recipient_ephemeral_pk: bytes,
    bundle: bytes,
    signer_ed25519_sk: bytes,
) -> bytes:
    sealed = seal_box(bundle, recipient_ephemeral_pk, LINK_SEAL_EPHEMERAL_SEED)
    head = bytes([0x01, 0x01]) + uuid_bytes(user_id) + recipient_ephemeral_pk + sealed
    message = link_bundle_message(user_id, link_id, recipient_ephemeral_pk, head)
    return head + sign_detached(message, signer_ed25519_sk)


def open_link_bundle(
    blob: bytes,
    user_id: str,
    link_id: str,
    ephemeral_sk: bytes,
    signer_ed25519_pk: bytes,
) -> bytes:
    if len(blob) != LINK_BUNDLE_LENGTH:
        raise Refused("E_LENGTH")
    if blob[0] != 0x01:
        raise Refused("E_VERSION")
    if blob[1] != 0x01:
        raise Refused("E_UNSUPPORTED")
    message = link_bundle_message(user_id, link_id, blob[18:50], blob[0:203])
    verify_detached(blob[203:267], message, signer_ed25519_pk)
    try:
        return bindings.crypto_box_seal_open(blob[50:203], ephemeral_sk, blob[50:82])
    except CryptoError:
        raise Refused("E_AUTH") from None


def fingerprint(x25519_pk: bytes, ed25519_pk: bytes) -> bytes:
    if len(x25519_pk) != 32 or len(ed25519_pk) != 32:
        raise Refused("E_LENGTH")
    return sha256(LABEL_ID + x25519_pk + ed25519_pk)


def safety_number(first: bytes, second: bytes) -> str:
    if len(first) != 32 or len(second) != 32:
        raise Refused("E_LENGTH")
    low, high = sorted([first, second])
    digest = sha256(LABEL_SAFETY + low + high)
    return str(int.from_bytes(digest, "big") % 10**60).zfill(60)


def verify_uri(user_id: str, ed25519_pk: bytes, x25519_pk: bytes) -> str:
    check_uuid_v4(user_id)
    if len(ed25519_pk) != 32 or len(x25519_pk) != 32:
        raise Refused("E_LENGTH")
    return (
        "calflex://verify/1?u="
        + user_id
        + "&k="
        + b64u_encode(ed25519_pk)
        + "&x="
        + b64u_encode(x25519_pk)
        + "&f="
        + fingerprint(x25519_pk, ed25519_pk).hex()
    )


def parse_verify_uri(uri: str) -> dict[str, object]:
    prefix = "calflex://verify/1?"
    if not uri.startswith("calflex://verify/"):
        raise Refused("E_VERSION")
    if not uri.startswith(prefix):
        raise Refused("E_VERSION")
    parts: dict[str, str] = {}
    for chunk in uri[len(prefix) :].split("&"):
        key, eq, value = chunk.partition("=")
        if not eq or key in parts or key not in ("u", "k", "x", "f"):
            raise Refused("E_VERIFY")
        parts[key] = value
    if list(parts) != ["u", "k", "x", "f"]:
        raise Refused("E_VERIFY")
    check_uuid_v4(parts["u"])
    ed25519_pk = b64u_decode(parts["k"])
    x25519_pk = b64u_decode(parts["x"])
    if len(ed25519_pk) != 32 or len(x25519_pk) != 32:
        raise Refused("E_LENGTH")
    if not re.fullmatch(r"[0-9a-f]{64}", parts["f"]):
        raise Refused("E_ENCODING")
    if fingerprint(x25519_pk, ed25519_pk).hex() != parts["f"]:
        raise Refused("E_VERIFY")
    return {
        "user_id": parts["u"],
        "ed25519_pk": ed25519_pk,
        "x25519_pk": x25519_pk,
        "fingerprint": parts["f"],
    }


# --------------------------------------------------------------------------------------------
# Payload validation (spec/crypto.md §4)
# --------------------------------------------------------------------------------------------

EVENT_MEMBERS = {
    "title",
    "description",
    "descriptionContentType",
    "locations",
    "virtualLocations",
    "links",
    "participants",
    "replyTo",
    "keywords",
    "categories",
    "locale",
    "priority",
    "freeBusyStatus",
    "status",
    "color",
    "relatedTo",
}
CALENDAR_MEMBERS = {"name", "color"}


def validate_payload(blob: bytes, kind: str) -> object:
    try:
        text = blob.decode("utf-8")
    except UnicodeDecodeError:
        raise Refused("E_PAYLOAD") from None
    if _duplicate_keys(text):
        # A JSON parser keeps only the last member, so two spellings of one payload
        # would otherwise open as the same object (spec/crypto.md §4.2).
        raise Refused("E_PAYLOAD")
    try:
        value = json.loads(text)
    except ValueError:
        raise Refused("E_PAYLOAD") from None
    if jcs.dumps(value) != blob:
        # Valid JSON, but not JCS: two spellings of one payload would otherwise both open.
        raise Refused("E_PAYLOAD")
    if not isinstance(value, dict):
        raise Refused("E_PAYLOAD")
    for member_value in value.values():
        if member_value is None:
            raise Refused("E_PAYLOAD")
        _check_json_types(member_value)
    if value.get("@type") != ("Event" if kind == "event" else "Calendar"):
        raise Refused("E_PAYLOAD")
    if kind == "event":
        allowed = EVENT_MEMBERS
    else:
        allowed = CALENDAR_MEMBERS
    if set(value) - allowed - {"@type"}:
        raise Refused("E_PAYLOAD")
    if kind == "calendar":
        name = value.get("name")
        color = value.get("color")
        if (
            not isinstance(name, str)
            or not 1 <= len(name.encode()) <= 255
            or not isinstance(color, str)
            or not re.fullmatch(r"#[0-9a-f]{6}([0-9a-f]{2})?", color)
        ):
            raise Refused("E_PAYLOAD")
    return value


def _check_json_types(value: object) -> None:
    if isinstance(value, dict):
        for item in value.values():
            if item is None:
                raise Refused("E_PAYLOAD")
            _check_json_types(item)
    elif isinstance(value, list):
        for item in value:
            _check_json_types(item)
    elif isinstance(value, (bool, str)):
        return
    elif isinstance(value, int):
        if not -(2**53 - 1) <= value <= 2**53 - 1:
            raise Refused("E_PAYLOAD")
    else:
        # A float, or anything json.loads produced that is not an integer.
        raise Refused("E_PAYLOAD")


def _duplicate_keys(text: str) -> list[str]:
    """Member names that appear twice in an object, at any depth (a JSON parser hides this)."""
    collected: list[str] = []

    def make(pairs):
        seen = set()
        for key, _ in pairs:
            if key in seen:
                collected.append(key)
            seen.add(key)
        return dict(pairs)

    json.loads(text, object_pairs_hook=make)
    return collected


# --------------------------------------------------------------------------------------------
# Vector building
# --------------------------------------------------------------------------------------------

BASIC_AAD_INPUTS = {
    "calendar_id": CALENDAR_ID,
    "uid": EVENT_UID,
    "recurrence_id": "",
    "epoch": 1,
    "dtstart": "zoned:Europe/Berlin@20260401T110000",
    "end": "zoned:Europe/Berlin@20260401T120000",
    "rrule": "none",
}


def aad_from_inputs(inputs: dict) -> bytes:
    return aad_event(
        inputs["calendar_id"],
        inputs["uid"],
        inputs["recurrence_id"],
        inputs["epoch"],
        inputs,
    )


def positive(vid, spec, purpose, inputs, expected=None, **extra):
    vector = {"id": vid, "kind": "positive", "spec": spec, "purpose": purpose, "inputs": inputs}
    if expected is not None:
        vector["expected"] = expected
    vector.update(extra)
    return vector


def negative(vid, spec, purpose, inputs, error):
    return {
        "id": vid,
        "kind": "negative",
        "spec": spec,
        "purpose": purpose,
        "inputs": inputs,
        "expected": {"error": error},
    }


def flip(blob: bytes, index: int) -> bytes:
    return blob[:index] + bytes([blob[index] ^ 0x01]) + blob[index + 1 :]


def payload_bytes_from_inputs(inputs: dict, kind: str) -> bytes:
    if "payload_hex" in inputs:
        blob = bytes.fromhex(inputs["payload_hex"])
    elif "payload_text" in inputs:
        blob = inputs["payload_text"].encode()
    else:
        blob = jcs.dumps(inputs["payload_object"])
    validate_payload(blob, kind)
    return blob


def do_seal(inputs: dict, kind: str, ceiling: int) -> bytes:
    payload = payload_bytes_from_inputs(inputs, kind)
    if kind == "event":
        aad = aad_from_inputs(inputs)
    else:
        aad = aad_meta(inputs["calendar_id"], inputs["epoch"])
    return seal_envelope(
        bytes.fromhex(inputs["cck_hex"]),
        inputs["epoch"],
        bytes.fromhex(inputs["nonce_hex"]),
        aad,
        payload,
        ceiling,
    )


def do_open(inputs: dict, kind: str, ceiling: int) -> object:
    if kind == "event":
        aad = aad_from_inputs(inputs)
    else:
        aad = aad_meta(inputs["calendar_id"], inputs["epoch"])
    plain = open_envelope(
        bytes.fromhex(inputs["cck_hex"]), bytes.fromhex(inputs["envelope_hex"]), aad, ceiling
    )
    return validate_payload(plain, kind)


# --------------------------------------------------------------------------------------------
# envelope-v1.json
# --------------------------------------------------------------------------------------------


def envelope_vectors() -> list[dict]:
    aad = aad_from_inputs(BASIC_AAD_INPUTS)
    payload = jcs.dumps(EVENT_PAYLOAD)
    validate_payload(payload, "event")
    blob = seal_envelope(TEST_CCK, 1, TEST_NONCE, aad, payload, MAX_EVENT_ENVELOPE_BYTES)
    digest = sha256(blob)
    seal_inputs = dict(BASIC_AAD_INPUTS)
    seal_inputs.update(
        {
            "cck_hex": TEST_CCK.hex(),
            "nonce_hex": TEST_NONCE.hex(),
            "payload_object": EVENT_PAYLOAD,
        }
    )
    open_inputs = dict(BASIC_AAD_INPUTS)
    open_inputs.update({"cck_hex": TEST_CCK.hex(), "envelope_hex": blob.hex()})

    max_epoch_inputs = dict(seal_inputs, epoch=MAX_EPOCH)
    zero_epoch_inputs = dict(seal_inputs, epoch=0)

    vectors = [
        positive(
            "envelope-event-seal-basic",
            "§1.2",
            "Seal the fixed test event with a fixed nonce, so the envelope is a constant.",
            seal_inputs,
            {
                "aad_hex": aad.hex(),
                "envelope_hex": blob.hex(),
                "envelope_bytes": len(blob),
                "envelope_sha256_hex": digest.hex(),
                "payload_jcs": payload.decode(),
            },
        ),
        positive(
            "envelope-event-open-basic",
            "§1.3",
            "Open that envelope: the payload is exactly the object that was sealed.",
            open_inputs,
            {"payload_object": EVENT_PAYLOAD, "payload_jcs": payload.decode()},
        ),
        positive(
            "envelope-event-seal-epoch-max",
            "§1.1",
            "Epoch 2147483647 (MAX_EPOCH) is the highest a wire epoch may carry.",
            max_epoch_inputs,
            {
                "envelope_hex": seal_envelope(
                    TEST_CCK, MAX_EPOCH, TEST_NONCE, aad_from_inputs(max_epoch_inputs), payload,
                    MAX_EVENT_ENVELOPE_BYTES,
                ).hex(),
                "epoch_field_hex": u32(MAX_EPOCH).hex(),
            },
        ),
        positive(
            "envelope-event-seal-epoch-zero",
            "§1.1",
            "Epoch 0 is legal in the format though our clients start at 1 (E13-R01).",
            zero_epoch_inputs,
            {
                "envelope_hex": seal_envelope(
                    TEST_CCK, 0, TEST_NONCE, aad_from_inputs(zero_epoch_inputs), payload,
                    MAX_EVENT_ENVELOPE_BYTES,
                ).hex(),
                "epoch_field_hex": u32(0).hex(),
            },
        ),
        negative(
            "envelope-seal-epoch-over-max",
            "§1.2",
            "Sealing epoch 2^31 is refused: the field is a u32 but the columns are integers.",
            dict(seal_inputs, epoch=2**31),
            "E_EPOCH",
        ),
        negative(
            "envelope-seal-epoch-negative",
            "§1.2",
            "A negative epoch is refused before anything is encrypted.",
            dict(seal_inputs, epoch=-1),
            "E_EPOCH",
        ),
        negative(
            "envelope-open-empty",
            "§1.3",
            "A zero-length blob is shorter than the 45 fixed bytes.",
            dict(open_inputs, envelope_hex=""),
            "E_LENGTH",
        ),
        negative(
            "envelope-open-44-bytes",
            "§1.3",
            "One byte short of ENVELOPE_FIXED_BYTES: the length check comes first.",
            dict(open_inputs, envelope_hex=blob[:44].hex()),
            "E_LENGTH",
        ),
        negative(
            "envelope-open-version-02",
            "§1.3",
            "Version 0x02 is unknown, whatever else the blob holds.",
            dict(open_inputs, envelope_hex=(bytes([0x02]) + blob[1:]).hex()),
            "E_VERSION",
        ),
        negative(
            "envelope-open-epoch-over-max",
            "§1.3",
            "The header's epoch is 0x80000000: E_EPOCH, before any AEAD work.",
            dict(open_inputs, envelope_hex=(blob[:1] + u32(2**31) + blob[5:]).hex()),
            "E_EPOCH",
        ),
        negative(
            "envelope-open-tag-flipped",
            "§1.3",
            "One bit of the Poly1305 tag flipped: E_AUTH, and no partial plaintext.",
            dict(open_inputs, envelope_hex=flip(blob, len(blob) - 1).hex()),
            "E_AUTH",
        ),
        negative(
            "envelope-open-ciphertext-flipped",
            "§1.3",
            "One bit of the ciphertext flipped: the same E_AUTH as a wrong key.",
            dict(open_inputs, envelope_hex=flip(blob, 29).hex()),
            "E_AUTH",
        ),
        negative(
            "envelope-open-nonce-flipped",
            "§1.3",
            "One bit of the nonce flipped: E_AUTH (the nonce is an AEAD input, not a header field).",
            dict(open_inputs, envelope_hex=flip(blob, 5).hex()),
            "E_AUTH",
        ),
        negative(
            "envelope-open-truncated",
            "§1.3",
            "The last byte dropped: still 45+ bytes, so the AEAD refuses it, not the length check.",
            dict(open_inputs, envelope_hex=blob[:-1].hex()),
            "E_AUTH",
        ),
        negative(
            "envelope-open-wrong-cck",
            "§1.3",
            "The same envelope under another CCK: E_AUTH.",
            dict(open_inputs, cck_hex=(bytes([0x77]) * 32).hex()),
            "E_AUTH",
        ),
        negative(
            "envelope-open-aad-uid-changed",
            "§2.2",
            "The skeleton's UID changed: field 2 of the AAD no longer matches the tag.",
            dict(open_inputs, uid="99999999-9999-4999-8999-999999999999"),
            "E_AUTH",
        ),
        negative(
            "envelope-open-aad-calendar-changed",
            "§2.2",
            "The calendar id changed: field 1 (D-14) makes an envelope unmovable between calendars.",
            dict(open_inputs, calendar_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            "E_AUTH",
        ),
        negative(
            "envelope-open-aad-recurrence-changed",
            "§5.2",
            "The recurrence_id changed: an override's envelope cannot be served as the master's.",
            dict(open_inputs, recurrence_id="20260401T090000Z"),
            "E_AUTH",
        ),
        negative(
            "envelope-open-aad-dtstart-changed",
            "§3.1",
            "The bound DTSTART moved by an hour: the tag no longer verifies.",
            dict(open_inputs, dtstart="zoned:Europe/Berlin@20260401T100000"),
            "E_AUTH",
        ),
        negative(
            "envelope-open-aad-end-changed",
            "§3.2",
            "DTEND replaced by a duration of the same length: still E_AUTH.",
            dict(open_inputs, end="dur:PT1H"),
            "E_AUTH",
        ),
        negative(
            "envelope-open-aad-rrule-changed",
            "§3.3",
            "A rule added to an event that had none: E_AUTH.",
            dict(open_inputs, rrule="rrule:FREQ=WEEKLY;COUNT=10"),
            "E_AUTH",
        ),
        positive(
            "envelope-event-sha256-basic",
            "§5.1",
            "The skeleton value is the SHA-256 of the complete envelope, 64 lowercase hex digits.",
            {"envelope_hex": blob.hex()},
            {"envelope_sha256_hex": digest.hex(), "hex_digits": 64, "lowercase": True},
        ),
        positive(
            "envelope-event-sha256-flipped-differs",
            "§5.1",
            "One bit elsewhere in the envelope gives a different skeleton hash.",
            {"envelope_hex": flip(blob, 29).hex()},
            {"envelope_sha256_hex": sha256(flip(blob, 29)).hex()},
            differs_from="envelope-event-sha256-basic",
        ),
        negative(
            "envelope-event-sha256-uppercase-refused",
            "§5.1",
            "An uppercase hex skeleton value is not the pinned encoding.",
            {"property_value": digest.hex().upper()},
            "E_SKELETON",
        ),
        negative(
            "envelope-event-sha256-short-refused",
            "§5.1",
            "63 hex digits are not the pinned encoding either.",
            {"property_value": digest.hex()[:63]},
            "E_SKELETON",
        ),
        negative(
            "envelope-seal-payload-forbidden-member",
            "§4.2",
            "`uid` is bound by the skeleton and forbidden in the payload.",
            dict(seal_inputs, payload_object=dict(EVENT_PAYLOAD, uid=EVENT_UID)),
            "E_PAYLOAD",
        ),
        negative(
            "envelope-seal-payload-null",
            "§4.2",
            "A null member value is refused.",
            dict(seal_inputs, payload_object=dict(EVENT_PAYLOAD, description=None)),
            "E_PAYLOAD",
        ),
        negative(
            "envelope-seal-payload-missing-type",
            "§4.2",
            "`@type` is required and must be `Event`.",
            dict(seal_inputs, payload_object={"title": "no type (test value)"}),
            "E_PAYLOAD",
        ),
        negative(
            "envelope-seal-payload-float",
            "§4.2",
            "Numbers are integers only: a float is refused.",
            dict(seal_inputs, payload_object=dict(EVENT_PAYLOAD, priority=1.5)),
            "E_PAYLOAD",
        ),
        negative(
            "envelope-open-payload-not-jcs",
            "§4.1",
            "Valid JSON with members in the wrong order is not JCS, so opening it is refused.",
            dict(
                open_inputs,
                envelope_hex=seal_envelope(
                    TEST_CCK,
                    1,
                    TEST_NONCE,
                    aad,
                    b'{"title":"Physio (test value)","@type":"Event"}',
                    MAX_EVENT_ENVELOPE_BYTES,
                ).hex(),
            ),
            "E_PAYLOAD",
        ),
        negative(
            "envelope-open-payload-duplicate-member",
            "§4.2",
            "Two members with one name: a JSON parser would hide the difference.",
            dict(
                open_inputs,
                envelope_hex=seal_envelope(
                    TEST_CCK,
                    1,
                    TEST_NONCE,
                    aad,
                    b'{"@type":"Event","title":"a","title":"b"}',
                    MAX_EVENT_ENVELOPE_BYTES,
                ).hex(),
            ),
            "E_PAYLOAD",
        ),
        negative(
            "envelope-open-payload-wrong-type",
            "§4.2",
            "A Calendar payload is not an Event payload.",
            dict(
                open_inputs,
                envelope_hex=seal_envelope(
                    TEST_CCK,
                    1,
                    TEST_NONCE,
                    aad,
                    jcs.dumps(CALENDAR_PAYLOAD),
                    MAX_EVENT_ENVELOPE_BYTES,
                ).hex(),
            ),
            "E_PAYLOAD",
        ),
    ]
    return vectors




# --------------------------------------------------------------------------------------------
# aad-v1.json
# --------------------------------------------------------------------------------------------


def aad_vectors() -> list[dict]:
    basic = aad_from_inputs(BASIC_AAD_INPUTS)
    fields_basic = {key: BASIC_AAD_INPUTS[key] for key in ("dtstart", "end", "rrule")}
    override_inputs = dict(BASIC_AAD_INPUTS, recurrence_id="20260401T090000Z")
    skeleton_with_rdate_exdate = BASIC_SKELETON + [
        "RDATE;TZID=Europe/Berlin:20260408T110000",
        "EXDATE;TZID=Europe/Berlin:20260415T110000",
    ]
    with_rdates = dict(BASIC_AAD_INPUTS)
    parsed = timing_fields(skeleton_with_rdate_exdate)
    assert all(parsed[key] == with_rdates[key] for key in ("dtstart", "end", "rrule")), parsed
    assert parsed["recurrence_id"] == ""

    def diff(vid, purpose, overrides, spec="§2.2"):
        inputs = dict(BASIC_AAD_INPUTS)
        inputs.update(overrides)
        return positive(
            vid,
            spec,
            purpose,
            inputs,
            {"aad_hex": aad_from_inputs(inputs).hex()},
            differs_from="aad-event-master",
        )

    return [
        positive(
            "aad-event-master",
            "§2.2",
            "The seven fields of the master's AAD; the master's recurrence_id field is empty.",
            BASIC_AAD_INPUTS,
            {
                "aad_hex": basic.hex(),
                "aad_bytes": len(basic),
                "label": "calflex-v1",
                "label_hex": LABEL_EVENT.hex(),
                "fields": [
                    CALENDAR_ID,
                    EVENT_UID,
                    "",
                    "1",
                    "zoned:Europe/Berlin@20260401T110000",
                    "zoned:Europe/Berlin@20260401T120000",
                    "none",
                ],
                "field_length_prefixes_hex": [
                    u32(len(CALENDAR_ID)).hex(),
                    u32(len(EVENT_UID)).hex(),
                    u32(0).hex(),
                    u32(1).hex(),
                    u32(len("zoned:Europe/Berlin@20260401T110000")).hex(),
                    u32(len("zoned:Europe/Berlin@20260401T120000")).hex(),
                    u32(len("none")).hex(),
                ],
            },
        ),
        positive(
            "aad-from-skeleton-master",
            "§3",
            "The same AAD, built the way a client builds it: parsed skeleton properties.",
            {
                "calendar_id": CALENDAR_ID,
                "uid": EVENT_UID,
                "epoch": 1,
                "skeleton_properties": BASIC_SKELETON,
                **fields_basic,
                "recurrence_id": "",
            },
            {"aad_hex": basic.hex(), "fields": {**fields_basic, "recurrence_id": ""}},
            same_as="aad-event-master",
        ),
        positive(
            "aad-event-override",
            "§5.2",
            "An override's AAD carries the canonical recurrence_id in field 3.",
            override_inputs,
            {"aad_hex": aad_from_inputs(override_inputs).hex()},
            differs_from="aad-event-master",
        ),
        positive(
            "aad-event-rdate-exdate-not-bound",
            "§2.6",
            "RDATE and EXDATE are in the skeleton and not in the AAD: the master's AAD is unchanged.",
            {
                "calendar_id": CALENDAR_ID,
                "uid": EVENT_UID,
                "epoch": 1,
                "skeleton_properties": skeleton_with_rdate_exdate,
                **parsed,
            },
            {"aad_hex": basic.hex(), "fields": {**fields_basic, "recurrence_id": ""}},
            same_as="aad-event-master",
        ),
        positive(
            "aad-uid-multibyte",
            "§2.1",
            "The length prefix counts UTF-8 bytes: a two-byte character counts twice.",
            dict(BASIC_AAD_INPUTS, uid="\u00dcbung (test value)"),
            {
                "aad_hex": aad_from_inputs(dict(BASIC_AAD_INPUTS, uid="\u00dcbung (test value)")).hex(),
                "uid_utf8_bytes": len("\u00dcbung (test value)".encode()),
                "uid_length_prefix_hex": u32(len("\u00dcbung (test value)".encode())).hex(),
            },
        ),
        positive(
            "aad-uid-embedded-nul",
            "§2.1",
            "A length prefix, not a terminator: a NUL inside a UID stays inside the field.",
            dict(BASIC_AAD_INPUTS, uid="a\u0000b"),
            {
                "aad_hex": aad_from_inputs(dict(BASIC_AAD_INPUTS, uid="a\u0000b")).hex(),
                "uid_length_prefix_hex": u32(3).hex(),
            },
        ),
        positive(
            "aad-event-uid-text-unescaped",
            "§2.2",
            "Field 2 is the parsed UID value: `UID:abc\\,def` binds `abc,def`.",
            dict(BASIC_AAD_INPUTS, uid="abc,def"),
            {
                "aad_hex": aad_from_inputs(dict(BASIC_AAD_INPUTS, uid="abc,def")).hex(),
                "skeleton_property": "UID:abc\\,def",
            },
        ),
        diff("aad-diff-uid", "A different UID gives a different AAD (field 2).", {"uid": "99999999-9999-4999-8999-999999999999"}),
        diff("aad-diff-calendar-id", "A different calendar gives a different AAD (field 1, D-14).", {"calendar_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}),
        diff("aad-diff-epoch", "A different epoch gives a different AAD (field 4).", {"epoch": 2}),
        diff("aad-diff-recurrence-id", "A recurrence_id gives a different AAD (field 3, D-14).", {"recurrence_id": "20260401T090000Z"}),
        diff("aad-diff-dtstart", "A different DTSTART gives a different AAD (field 5).", {"dtstart": "zoned:Europe/Berlin@20260401T100000"}),
        diff("aad-diff-end", "A different end gives a different AAD (field 6).", {"end": "dur:PT1H"}),
        diff("aad-diff-rrule", "A rule gives a different AAD (field 7).", {"rrule": "rrule:FREQ=WEEKLY;COUNT=10"}),
        diff(
            "aad-diff-tzid-spelling",
            "The bound TZID is the skeleton's spelling: a link name is not normalised.",
            {"dtstart": "zoned:Asia/Calcutta@20260401T153000", "end": "zoned:Asia/Calcutta@20260401T163000"},
        ),
        positive(
            "aad-epoch-max-decimal",
            "§2.2",
            "The epoch is canonical decimal, so 2^31-1 is ten digits with no padding.",
            dict(BASIC_AAD_INPUTS, epoch=MAX_EPOCH),
            {
                "aad_hex": aad_from_inputs(dict(BASIC_AAD_INPUTS, epoch=MAX_EPOCH)).hex(),
                "epoch_field": str(MAX_EPOCH),
                "epoch_field_length_prefix_hex": u32(len(str(MAX_EPOCH))).hex(),
            },
        ),
        positive(
            "aad-label-byte-8",
            "§1.4",
            "The two labels differ at byte 8, so no field content can make the two AADs collide.",
            {
                "event_label_hex": LABEL_EVENT.hex(),
                "meta_label_hex": LABEL_META.hex(),
                "meta_aad_hex": aad_meta(CALENDAR_ID, 1).hex(),
            },
            {
                "first_differing_index": 8,
                "event_label_byte_8": "v",
                "meta_label_byte_8": "m",
            },
        ),
        negative(
            "aad-calendar-id-uppercase-refused",
            "§0.2",
            "An uppercase UUID is not the canonical text form.",
            dict(BASIC_AAD_INPUTS, calendar_id=CALENDAR_ID.upper()),
            "E_ENCODING",
        ),
        negative(
            "aad-calendar-id-not-v4-refused",
            "§0.2",
            "A UUIDv1 is not an identifier this format accepts (INV-03).",
            dict(BASIC_AAD_INPUTS, calendar_id="11111111-1111-1111-8111-111111111111"),
            "E_ENCODING",
        ),
        negative(
            "aad-uid-empty-refused",
            "§2.2",
            "The UID field may not be empty; only the master's recurrence_id may.",
            dict(BASIC_AAD_INPUTS, uid=""),
            "E_SKELETON",
        ),
        negative(
            "aad-epoch-over-max-refused",
            "§2.2",
            "2^31 has no canonical field: the epoch range is checked before the AAD is built.",
            dict(BASIC_AAD_INPUTS, epoch=2**31),
            "E_EPOCH",
        ),
    ]


# --------------------------------------------------------------------------------------------
# canonical-timing-v1.json
# --------------------------------------------------------------------------------------------


def timing_vectors() -> list[dict]:
    def timing(vid, spec, purpose, lines, extra=None, instants=None):
        fields = timing_fields(lines)
        expected = {
            "dtstart": fields["dtstart"],
            "end": fields["end"],
            "rrule": fields["rrule"],
            "recurrence_id": fields["recurrence_id"],
        }
        if instants is not None:
            expected["instants"] = instants
            assert instant_of_time_field(fields["dtstart"]) == instants[0] if instants else True
        if extra:
            expected.update(extra)
        return positive(vid, spec, purpose, {"skeleton_properties": lines}, expected)

    def refused(vid, spec, purpose, lines, error):
        return negative(vid, spec, purpose, {"skeleton_properties": lines}, error)

    return [
        timing(
            "timing-dtstart-date",
            "§3.1",
            "An all-day start binds the date, never a midnight instant (INV-04).",
            ["UID:" + EVENT_UID, "DTSTART;VALUE=DATE:20260401", "DTEND;VALUE=DATE:20260402"],
        ),
        timing(
            "timing-dtstart-utc",
            "§3.1",
            "A UTC start binds the instant it spells.",
            ["UID:" + EVENT_UID, "DTSTART:20260401T090000Z", "DTEND:20260401T100000Z"],
        ),
        timing(
            "timing-dtstart-zoned",
            "§3.1",
            "A TZID start binds the zone name and the wall clock, not a computed instant.",
            BASIC_SKELETON,
            instants=["20260401T090000Z"],
        ),
        timing(
            "timing-dtstart-zoned-link-name",
            "§3.1",
            "A link name is bound as written: normalising it would move the AAD.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Asia/Calcutta:20260401T153000", "DTEND;TZID=Asia/Calcutta:20260401T163000"],
            instants=["20260401T100000Z"],
        ),
        refused(
            "timing-dtstart-floating-refused",
            "§3.1",
            "A DATE-TIME with neither Z nor TZID is floating and refused (INV-04).",
            ["UID:" + EVENT_UID, "DTSTART:20260401T090000"],
            "E_UNSUPPORTED",
        ),
        refused(
            "timing-dtstart-leap-second-refused",
            "§3.1",
            "Seconds 60 has no representation here.",
            ["UID:" + EVENT_UID, "DTSTART:20261231T235960Z"],
            "E_UNSUPPORTED",
        ),
        refused(
            "timing-dtstart-bad-date-refused",
            "§3.1",
            "30 February is not a date.",
            ["UID:" + EVENT_UID, "DTSTART;VALUE=DATE:20260230"],
            "E_SKELETON",
        ),
        refused(
            "timing-dtstart-missing-refused",
            "§3.1",
            "DTSTART is required in a VEVENT and in the AAD.",
            ["UID:" + EVENT_UID, "DTEND:20260401T100000Z"],
            "E_SKELETON",
        ),
        timing(
            "timing-end-duration",
            "§3.2",
            "A DURATION is bound as a duration, not converted to an end.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000", "DURATION:PT1H30M"],
        ),
        timing(
            "timing-end-none",
            "§3.2",
            "No end property at all binds the literal `none`.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000"],
        ),
        refused(
            "timing-end-both-refused",
            "§3.2",
            "DTEND and DURATION together are forbidden by RFC 5545 §3.6.1.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DTEND;TZID=Europe/Berlin:20260401T120000", "DURATION:PT1H"],
            "E_SKELETON",
        ),
        timing(
            "timing-duration-negative",
            "§3.2.1",
            "A negative duration keeps its sign and drops nothing else.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000", "DURATION:-PT15M"],
        ),
        timing(
            "timing-duration-zero",
            "§3.2.1",
            "Zero is written PT0S, with no sign.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000", "DURATION:+P0DT0H0M0S"],
        ),
        timing(
            "timing-duration-sixty-minutes",
            "§3.2.1",
            "No carrying: PT60M stays PT60M, so a nominal duration is never silently rewritten.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000", "DURATION:PT60M"],
        ),
        timing(
            "timing-duration-weeks",
            "§3.2.1",
            "Weeks stand alone (RFC 5545 forbids P1W2D).",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000", "DURATION:P2W"],
        ),
        refused(
            "timing-duration-mixed-week-refused",
            "§3.2.1",
            "Weeks mixed with days are invalid.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000", "DURATION:P1W2D"],
            "E_SKELETON",
        ),
        refused(
            "timing-duration-missing-unit-refused",
            "§3.2.1",
            "`P1H` has no unit for the 1.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000", "DURATION:P1H"],
            "E_SKELETON",
        ),
        timing(
            "timing-rrule-interval-one-dropped",
            "§3.3",
            "INTERVAL=1 is the RFC's default and is dropped: two spellings, one AAD field.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DTEND;TZID=Europe/Berlin:20260401T120000", "RRULE:FREQ=DAILY;INTERVAL=1;COUNT=5"],
        ),
        timing(
            "timing-rrule-plain-count",
            "§3.3",
            "The same rule without the redundant INTERVAL.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DTEND;TZID=Europe/Berlin:20260401T120000", "RRULE:FREQ=DAILY;COUNT=5"],
        ),
        timing(
            "timing-rrule-byday-sorted",
            "§3.3",
            "BYDAY is sorted (weekday, then ordinal) and WKST=MO is the default and dropped.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=-1FR,2MO;WKST=MO"],
        ),
        timing(
            "timing-rrule-numeric-list-sorted",
            "§3.3",
            "Numeric lists are ascending, deduplicated and unsigned.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYMONTHDAY=+30,15,30"],
        ),
        timing(
            "timing-rrule-part-order",
            "§3.3",
            "Parts are emitted in the ABNF order, whatever order the skeleton used.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RRULE:BYDAY=TU,TH;COUNT=10;FREQ=WEEKLY"],
        ),
        timing(
            "timing-rrule-until-utc",
            "§3.3",
            "UNTIL is written as a UTC instant.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RRULE:FREQ=DAILY;UNTIL=20260410T090000Z"],
        ),
        timing(
            "timing-rrule-until-date",
            "§3.3",
            "An all-day rule's UNTIL stays a date.",
            ["UID:" + EVENT_UID, "DTSTART;VALUE=DATE:20260401", "DTEND;VALUE=DATE:20260402",
             "RRULE:FREQ=WEEKLY;UNTIL=20260630"],
        ),
        timing(
            "timing-rrule-none",
            "§3.3",
            "No RRULE binds the literal `none`; a DTSTART with only RDATEs is legitimate.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RDATE;TZID=Europe/Berlin:20260408T110000"],
        ),
        refused(
            "timing-rrule-x-part-refused",
            "§3.3",
            "An X- rule part is forbidden by the owner's ruling of 2026-10-12.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RRULE:FREQ=DAILY;X-CALFLEX-SKIP=1"],
            "E_UNSUPPORTED",
        ),
        refused(
            "timing-rrule-duplicate-part-refused",
            "§3.3",
            "COUNT twice is a malleability hole, not a last-one-wins.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=5;COUNT=6"],
            "E_SKELETON",
        ),
        refused(
            "timing-rrule-missing-freq-refused",
            "§3.3",
            "FREQ is required.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RRULE:COUNT=5"],
            "E_SKELETON",
        ),
        refused(
            "timing-rrule-out-of-range-refused",
            "§3.3",
            "BYMONTH 13 is out of range.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RRULE:FREQ=YEARLY;BYMONTH=13"],
            "E_SKELETON",
        ),
        refused(
            "timing-rrule-until-and-count-refused",
            "§3.3",
            "UNTIL and COUNT are mutually exclusive.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RRULE:FREQ=DAILY;UNTIL=20260410T090000Z;COUNT=5"],
            "E_SKELETON",
        ),
        timing(
            "timing-dst-europe-berlin-spring-skipped",
            "§3.4",
            "A local time in the spring gap: the AAD binds the wall clock, and the instant uses the offset before the gap.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260329T023000",
             "DTEND;TZID=Europe/Berlin:20260329T033000"],
            instants=["20260329T013000Z"],
            extra={
                "rfc": "RFC 5545 §3.3.5 form 3: a local time that does not occur is read with the UTC offset before the gap.",
                "cases_json_id": "berlin-2026-spring-skipped",
                "ical_js_note": "ical.js with a VTIMEZONE gives 20260329T003000Z here, which is why the AAD does not bind the instant.",
            },
        ),
        timing(
            "timing-dst-europe-berlin-autumn-repeated",
            "§3.4",
            "A local time in the autumn overlap: the first occurrence, i.e. the pre-transition offset.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20261025T023000",
             "DTEND;TZID=Europe/Berlin:20261025T033000"],
            instants=["20261025T003000Z"],
            extra={
                "rfc": "RFC 5545 §3.3.5 form 3: a local time that occurs twice refers to the first occurrence.",
                "cases_json_id": "berlin-2026-fall-repeated",
                "ical_js_note": "ical.js with a VTIMEZONE gives the second occurrence, 20261025T013000Z.",
            },
        ),
        timing(
            "timing-dst-daily-skipped-instance",
            "§3.4",
            "The ruling of 2026-10-12: a daily instance whose local time does not exist is kept, counted, and read with the offset before the gap.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260327T023000",
             "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=5"],
            instants=expand_daily_skipped("Europe/Berlin", "20260327T023000", 5),
            extra={
                "rfc": "RFC 5545 §3.3.10 as ruled on 2026-10-12 (docs/02 § Recurrence).",
                "cases_json_id": "berlin-2026-spring-daily-skipped",
            },
        ),
        timing(
            "timing-recurrence-id-two-spellings-utc",
            "§5.2",
            "A RECURRENCE-ID written as a UTC instant.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RECURRENCE-ID:20260401T090000Z"],
        ),
        timing(
            "timing-recurrence-id-two-spellings-tzid",
            "§5.2",
            "The same instant written with a TZID: one occurrence, one canonical recurrence_id.",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RECURRENCE-ID;TZID=Europe/Berlin:20260401T110000"],
            extra={
                "note": "Both spellings give the recurrence_id 20260401T090000Z, so one occurrence has one sidecar key (E04-R04)."
            },
        ),
        timing(
            "timing-recurrence-id-date",
            "§5.2",
            "A DATE RECURRENCE-ID stays eight digits.",
            ["UID:" + EVENT_UID, "DTSTART;VALUE=DATE:20260401", "DTEND;VALUE=DATE:20260402",
             "RECURRENCE-ID;VALUE=DATE:20260401"],
        ),
        refused(
            "timing-recurrence-id-floating-refused",
            "§5.2",
            "A floating RECURRENCE-ID is refused rather than read as UTC (recurrence-key.mjs).",
            ["UID:" + EVENT_UID, "DTSTART;TZID=Europe/Berlin:20260401T110000",
             "DURATION:PT1H", "RECURRENCE-ID:20260401T110000"],
            "E_SKELETON",
        ),
    ]


def expand_daily_skipped(zone: str, start_local: str, count: int) -> list[str]:
    naive = datetime.strptime(start_local, "%Y%m%dT%H%M%S")
    out = []
    for offset in range(count):
        local = naive + timedelta(days=offset)
        out.append(
            local.replace(tzinfo=ZoneInfo(zone), fold=0)
            .astimezone(UTC)
            .strftime("%Y%m%dT%H%M%SZ")
        )
    return out


# --------------------------------------------------------------------------------------------
# payload-jcs-v1.json
# --------------------------------------------------------------------------------------------


def payload_vectors() -> list[dict]:
    def jcs_vector(vid, purpose, obj):
        return positive(
            vid,
            "§4.1",
            purpose,
            {"object": obj},
            {"jcs": jcs.dumps(obj).decode()},
        )

    def payload_vector(vid, purpose, kind, inputs, jcs_text):
        return positive(
            vid,
            "§4.2" if kind == "event" else "§4.3",
            purpose,
            {"payload_kind": kind, **inputs},
            {"jcs": jcs_text},
        )

    def payload_refused(vid, purpose, kind, inputs, error, spec="§4.2"):
        return negative(vid, spec, purpose, {"payload_kind": kind, **inputs}, error)

    event_jcs = jcs.dumps(EVENT_PAYLOAD).decode()
    calendar_jcs = jcs.dumps(CALENDAR_PAYLOAD).decode()
    return [
        jcs_vector(
            "jcs-member-order",
            "Members are sorted by UTF-16 code unit; `@` sorts before letters.",
            {"zzz": 1, "@type": "x", "aaa": 2, "A": 3},
        ),
        jcs_vector(
            "jcs-string-escapes",
            "Escapes are RFC 8785's: short forms for \\b\\t\\n\\f\\r, \\u00xx lowercase for the rest, raw UTF-8 for everything else.",
            {
                "quote": 'a"b',
                "backslash": "a\\b",
                "controls": "\b\t\n\f\r\u0000\u0001\u001f",
                "german": "Gr\u00fc\u00dfe",
                "emoji": "\U0001f642",
                "separators": "\u2028\u2029",
            },
        ),
        jcs_vector(
            "jcs-integers",
            "Integers only, as ECMAScript writes them; the safe-integer range is the whole domain.",
            {"a": 0, "b": -1, "c": 9007199254740991, "d": -9007199254740991},
        ),
        jcs_vector(
            "jcs-no-whitespace",
            "No whitespace, no trailing newline, arrays and nested objects included.",
            {"a": [1, True, None, "x"], "b": {"c": {}}},
        ),
        jcs_vector(
            "jcs-astral-member-order",
            "Astral characters sort by their UTF-16 surrogate, above U+FFFF — not by code point.",
            {"\uffff": 1, "\U0001f600": 2},
        ),
        payload_vector(
            "payload-event-basic",
            "The fixed test event: non-ASCII content, an escaped quote, a backslash and a newline.",
            "event",
            {"payload_object": EVENT_PAYLOAD},
            event_jcs,
        ),
        payload_vector(
            "payload-calendar-basic",
            "A calendar's name and colour (D-18).",
            "calendar",
            {"payload_object": CALENDAR_PAYLOAD},
            calendar_jcs,
        ),
        payload_refused(
            "payload-event-forbidden-uid-refused",
            "`uid` belongs to the skeleton, not the payload.",
            "event",
            {"payload_object": dict(EVENT_PAYLOAD, uid=EVENT_UID)},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-event-forbidden-start-refused",
            "`start` is bound by the AAD, so a second copy would be a second authority.",
            "event",
            {"payload_object": dict(EVENT_PAYLOAD, start="2026-04-01T09:00:00")},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-event-forbidden-alerts-refused",
            "Alerts stay in the cleartext VALARM (D-08), so `alerts` is refused.",
            "event",
            {"payload_object": dict(EVENT_PAYLOAD, alerts={})},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-event-unknown-member-refused",
            "A member outside the version-1 list is refused, so adding one is a version bump.",
            "event",
            {"payload_object": dict(EVENT_PAYLOAD, notes="not a JSCalendar member")},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-event-null-refused",
            "A null member value is refused.",
            "event",
            {"payload_object": dict(EVENT_PAYLOAD, description=None)},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-event-float-refused",
            "Numbers are integers: a float would make JCS number formatting a compatibility surface.",
            "event",
            {"payload_object": {"@type": "Event", "priority": 1.5}},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-event-missing-type-refused",
            "`@type` is required.",
            "event",
            {"payload_object": {"title": "no type (test value)"}},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-event-wrong-type-refused",
            "`@type` must be `Event`.",
            "event",
            {"payload_object": {"@type": "Task", "title": "wrong type (test value)"}},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-event-top-level-array-refused",
            "The payload is a JSON object, not an array.",
            "event",
            {"payload_object": [{"@type": "Event"}]},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-event-duplicate-member-refused",
            "Two members with one name: refused, because a JSON parser hides the difference.",
            "event",
            {"payload_text": '{"@type":"Event","title":"a","title":"b"}'},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-event-not-jcs-refused",
            "Valid JSON with the members in the wrong order is not JCS.",
            "event",
            {"payload_text": '{"title":"Physio (test value)","@type":"Event"}'},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-event-not-utf8-refused",
            "A payload whose bytes are not valid UTF-8 is refused.",
            "event",
            {"payload_hex": b'{"@type":"Event","title":"caf\xff"}'.hex()},
            "E_PAYLOAD",
        ),
        payload_refused(
            "payload-calendar-no-name-refused",
            "A calendar payload without a name is refused.",
            "calendar",
            {"payload_object": {"@type": "Calendar", "color": "#3b82f6"}},
            "E_PAYLOAD",
            spec="§4.3",
        ),
        payload_refused(
            "payload-calendar-extra-member-refused",
            "The metadata payload carries the name and the colour, nothing else.",
            "calendar",
            {"payload_object": dict(CALENDAR_PAYLOAD, description="extra")},
            "E_PAYLOAD",
            spec="§4.3",
        ),
        payload_refused(
            "payload-calendar-uppercase-color-refused",
            "The colour is lowercase RFC 7986.",
            "calendar",
            {"payload_object": dict(CALENDAR_PAYLOAD, color="#3B82F6")},
            "E_PAYLOAD",
            spec="§4.3",
        ),
        payload_refused(
            "payload-calendar-short-color-refused",
            "A three-digit colour is not RFC 7986's form.",
            "calendar",
            {"payload_object": dict(CALENDAR_PAYLOAD, color="#fff")},
            "E_PAYLOAD",
            spec="§4.3",
        ),
    ]


# --------------------------------------------------------------------------------------------
# metadata-envelope-v1.json
# --------------------------------------------------------------------------------------------


def metadata_vectors() -> list[dict]:
    aad = aad_meta(CALENDAR_ID, 1)
    payload = jcs.dumps(CALENDAR_PAYLOAD)
    blob = seal_envelope(TEST_CCK, 1, TEST_NONCE, aad, payload, MAX_META_ENVELOPE_BYTES)
    seal_inputs = {
        "cck_hex": TEST_CCK.hex(),
        "nonce_hex": TEST_NONCE.hex(),
        "calendar_id": CALENDAR_ID,
        "epoch": 1,
        "payload_object": CALENDAR_PAYLOAD,
    }
    open_inputs = {"cck_hex": TEST_CCK.hex(), "calendar_id": CALENDAR_ID, "epoch": 1,
                   "envelope_hex": blob.hex()}
    event_open_inputs = dict(BASIC_AAD_INPUTS)
    event_open_inputs.update({"cck_hex": TEST_CCK.hex(), "envelope_hex": blob.hex()})
    big_name = "x" * 4200
    big_payload = {"@type": "Calendar", "color": "#3b82f6", "name": big_name}
    assert len(jcs.dumps(big_payload)) + ENVELOPE_FIXED_BYTES > MAX_META_ENVELOPE_BYTES

    basic_event = envelope_vectors()[0]
    return [
        positive(
            "metadata-seal-basic",
            "§1.4",
            "The calendar's name and colour sealed under the CCK, with `calflex-meta-v1` as the AAD label.",
            seal_inputs,
            {
                "aad_hex": aad.hex(),
                "envelope_hex": blob.hex(),
                "envelope_bytes": len(blob),
                "envelope_sha256_hex": sha256(blob).hex(),
                "payload_jcs": payload.decode(),
            },
        ),
        positive(
            "metadata-open-basic",
            "§1.3",
            "Opening it with the metadata AAD returns the name and colour.",
            open_inputs,
            {"payload_object": CALENDAR_PAYLOAD, "payload_jcs": payload.decode()},
        ),
        negative(
            "metadata-open-as-event",
            "§1.4",
            "A metadata envelope opened with the event AAD: the labels differ, so E_AUTH (D-18).",
            event_open_inputs,
            "E_AUTH",
        ),
        negative(
            "event-open-as-metadata",
            "§1.4",
            "And the reverse: an event envelope cannot be read as calendar metadata (D-18).",
            {
                "cck_hex": TEST_CCK.hex(),
                "calendar_id": CALENDAR_ID,
                "epoch": 1,
                "envelope_hex": basic_event["expected"]["envelope_hex"],
            },
            "E_AUTH",
        ),
        positive(
            "metadata-aad-diff-epoch",
            "§2.3",
            "The epoch is in the metadata AAD, so one epoch's envelope cannot be served as another's.",
            {"calendar_id": CALENDAR_ID, "epoch": 2},
            {"aad_hex": aad_meta(CALENDAR_ID, 2).hex()},
            differs_from="metadata-seal-basic",
        ),
        positive(
            "metadata-aad-diff-calendar",
            "§2.3",
            "So is the calendar id.",
            {"calendar_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "epoch": 1},
            {"aad_hex": aad_meta("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1).hex()},
            differs_from="metadata-seal-basic",
        ),
        negative(
            "metadata-seal-over-4096-refused",
            "§1.1",
            "A metadata envelope larger than the API's 4096 bytes is refused before it is stored.",
            dict(seal_inputs, payload_object=big_payload),
            "E_LENGTH",
        ),
    ]


# --------------------------------------------------------------------------------------------
# keys-v1.json
# --------------------------------------------------------------------------------------------


def key_vectors() -> list[dict]:
    a_x25519_pk = bindings.crypto_scalarmult_base(A_X25519_SEED)
    a_ed_pk, a_ed_sk = bindings.crypto_sign_seed_keypair(A_ED25519_SEED)
    b_x25519_pk = bindings.crypto_scalarmult_base(B_X25519_SEED)
    _b_ed_pk, _ = bindings.crypto_sign_seed_keypair(B_ED25519_SEED)
    bundle_a = key_bundle(A_X25519_SEED, a_ed_sk)
    kek = recovery_kek(TEST_KEK_SOURCE)
    phrase = recovery_phrase(TEST_KEK_SOURCE)
    wrapped = seal_wrapped_key(kek, USER_A, "recovery_code", TEST_NONCE, bundle_a)
    bad_checksum_phrase = " ".join(
        phrase.split()[:11] + ["abandon" if phrase.split()[11] != "abandon" else "ability"]
    )
    unknown_word_phrase = " ".join(phrase.split()[:11] + ["zzzz"])

    return [
        positive(
            "recovery-phrase-bip39-official-1",
            "§6.4",
            "The pinned word list and the checksum rule reproduce BIP-0039's own reference vector.",
            {"entropy_hex": BIP39_VECTORS[0][0]},
            {"phrase": BIP39_VECTORS[0][1], "words": 12, "wordlist_sha256": WORDLIST_SHA256},
        ),
        positive(
            "recovery-phrase-bip39-official-2",
            "§6.4",
            "And a second one, so a wrong word list cannot pass by luck.",
            {"entropy_hex": BIP39_VECTORS[1][0]},
            {"phrase": BIP39_VECTORS[1][1], "words": 12},
        ),
        positive(
            "recovery-phrase-from-entropy",
            "§6.4",
            "The 128-bit test entropy and the twelve words it encodes to.",
            {"entropy_hex": TEST_KEK_SOURCE.hex()},
            {"phrase": phrase, "words": 12, "sha256_of_entropy_prefix_4_bits": "0110"},
        ),
        positive(
            "recovery-phrase-to-entropy",
            "§6.4",
            "Typing the phrase back returns the same entropy, after the checksum passes.",
            {"phrase": phrase},
            {"entropy_hex": TEST_KEK_SOURCE.hex()},
        ),
        positive(
            "recovery-kek-basic",
            "§6.3.1",
            "The recovery-code KEK: HKDF-SHA-256 over the entropy, with ASCII salt and info.",
            {"entropy_hex": TEST_KEK_SOURCE.hex()},
            {
                "kek_hex": kek.hex(),
                "hash": "SHA-256",
                "salt": HKDF_SALT.decode(),
                "info": HKDF_INFO_RECOVERY_KEK.decode(),
                "length_bytes": 32,
            },
        ),
        negative(
            "recovery-phrase-bad-checksum-refused",
            "§6.4",
            "The same phrase with one word substituted: the checksum fails, so nothing is derived.",
            {"phrase": bad_checksum_phrase},
            "E_RECOVERY",
        ),
        negative(
            "recovery-phrase-unknown-word-refused",
            "§6.4",
            "A word that is not in the pinned 2048-word list.",
            {"phrase": unknown_word_phrase},
            "E_RECOVERY",
        ),
        negative(
            "recovery-phrase-eleven-words-refused",
            "§6.4",
            "Eleven words is not a recovery code.",
            {"phrase": " ".join(phrase.split()[:11])},
            "E_RECOVERY",
        ),
        positive(
            "key-bundle-tlv-basic",
            "§6.2",
            "The 105-byte KeyBundle: a version, then the X25519 secret key and the Ed25519 secret key, each length-prefixed.",
            {"x25519_sk_hex": A_X25519_SEED.hex(), "ed25519_seed_hex": A_ED25519_SEED.hex()},
            {
                "bundle_hex": bundle_a.hex(),
                "bundle_bytes": KEY_BUNDLE_LENGTH,
                "x25519_pk_hex": a_x25519_pk.hex(),
                "ed25519_pk_hex": a_ed_pk.hex(),
            },
        ),
        positive(
            "key-bundle-public-keys-match",
            "§6.2",
            "The unwrapped keys reproduce the public keys in `user_keys`.",
            {
                "bundle_hex": bundle_a.hex(),
                "x25519_pk_hex": a_x25519_pk.hex(),
                "ed25519_pk_hex": a_ed_pk.hex(),
            },
            {"matches": True},
        ),
        negative(
            "key-bundle-public-key-mismatch-refused",
            "§6.2",
            "The bundle unpacks to keys that do not match the stored public keys: E_PAYLOAD.",
            {
                "bundle_hex": bundle_a.hex(),
                "x25519_pk_hex": b_x25519_pk.hex(),
                "ed25519_pk_hex": a_ed_pk.hex(),
            },
            "E_PAYLOAD",
        ),
        negative(
            "key-bundle-wrong-length-refused",
            "§6.2",
            "A 31-byte X25519 secret key is not the pinned length.",
            {"bundle_hex": (b"\x01" + lp32(A_X25519_SEED[:31]) + lp32(a_ed_sk)).hex()},
            "E_LENGTH",
        ),
        positive(
            "wrapped-key-seal-basic",
            "§6.3",
            "The user's private keys wrapped under the recovery-code KEK, with a fixed nonce.",
            {
                "kek_hex": kek.hex(),
                "user_id": USER_A,
                "kind": "recovery_code",
                "nonce_hex": TEST_NONCE.hex(),
                "bundle_hex": bundle_a.hex(),
            },
            {
                "wrapped_key_hex": wrapped.hex(),
                "wrapped_key_bytes": 147,
                "aad_hex": aad_keywrap(USER_A, "recovery_code").hex(),
                "phrase": phrase,
            },
        ),
        positive(
            "wrapped-key-open-basic",
            "§6.3",
            "Opening it returns the same KeyBundle.",
            {
                "kek_hex": kek.hex(),
                "user_id": USER_A,
                "kind": "recovery_code",
                "wrapped_key_hex": wrapped.hex(),
            },
            {"bundle_hex": bundle_a.hex(), "x25519_sk_hex": A_X25519_SEED.hex(),
             "ed25519_sk_hex": a_ed_sk.hex()},
        ),
        negative(
            "wrapped-key-open-wrong-user",
            "§6.3",
            "The AAD binds the owner, so a wrap moved to another user's row is E_AUTH.",
            {
                "kek_hex": kek.hex(),
                "user_id": USER_B,
                "kind": "recovery_code",
                "wrapped_key_hex": wrapped.hex(),
            },
            "E_AUTH",
        ),
        negative(
            "wrapped-key-open-caller-kind-mismatch",
            "§6.3",
            "A caller that expects an escrow wrap is handed a recovery-code one.",
            {
                "kek_hex": kek.hex(),
                "user_id": USER_A,
                "kind": "escrow",
                "wrapped_key_hex": wrapped.hex(),
            },
            "E_VERSION",
        ),
        negative(
            "wrapped-key-open-escrow-kind-reserved",
            "§6.3.2",
            "Kind 0x02 is reserved for Phase 7 and refused rather than guessed at.",
            {
                "kek_hex": kek.hex(),
                "user_id": USER_A,
                "kind": "recovery_code",
                "wrapped_key_hex": (wrapped[:1] + b"\x02" + wrapped[2:]).hex(),
            },
            "E_UNSUPPORTED",
        ),
        negative(
            "wrapped-key-open-version-02",
            "§6.3",
            "Version 0x02 is unknown.",
            {
                "kek_hex": kek.hex(),
                "user_id": USER_A,
                "kind": "recovery_code",
                "wrapped_key_hex": (b"\x02" + wrapped[1:]).hex(),
            },
            "E_VERSION",
        ),
        negative(
            "wrapped-key-open-truncated",
            "§6.3",
            "41 bytes is shorter than the fixed part (1 + 1 + 24 + 16).",
            {
                "kek_hex": kek.hex(),
                "user_id": USER_A,
                "kind": "recovery_code",
                "wrapped_key_hex": wrapped[:41].hex(),
            },
            "E_LENGTH",
        ),
        negative(
            "wrapped-key-open-over-512-refused",
            "§6.3.3",
            "513 bytes exceeds the API's ceiling for a wrap.",
            {
                "kek_hex": kek.hex(),
                "user_id": USER_A,
                "kind": "recovery_code",
                "wrapped_key_hex": (wrapped[:26] + bytes(487)).hex(),
            },
            "E_LENGTH",
        ),
        negative(
            "wrapped-key-open-tag-flipped",
            "§6.3",
            "One bit of the tag flipped.",
            {
                "kek_hex": kek.hex(),
                "user_id": USER_A,
                "kind": "recovery_code",
                "wrapped_key_hex": flip(wrapped, len(wrapped) - 1).hex(),
            },
            "E_AUTH",
        ),
        positive(
            "identity-keys-from-seeds",
            "§6.1",
            "The invented seeds and the public keys they produce.",
            {"x25519_sk_hex": A_X25519_SEED.hex(), "ed25519_seed_hex": A_ED25519_SEED.hex()},
            {
                "x25519_pk_hex": a_x25519_pk.hex(),
                "ed25519_pk_hex": a_ed_pk.hex(),
                "ed25519_sk_hex": a_ed_sk.hex(),
            },
        ),
    ]


# --------------------------------------------------------------------------------------------
# cck-records-v1.json
# --------------------------------------------------------------------------------------------


def cck_vectors() -> list[dict]:
    a_ed_pk, a_ed_sk = bindings.crypto_sign_seed_keypair(A_ED25519_SEED)
    b_x25519_pk = bindings.crypto_scalarmult_base(B_X25519_SEED)
    c_x25519_pk = bindings.crypto_scalarmult_base(C_X25519_SEED)
    c_ed_pk, _ = bindings.crypto_sign_seed_keypair(C_ED25519_SEED)
    record = seal_cck_record(
        TEST_CCK, CALENDAR_ID, 1, USER_B, b_x25519_pk, USER_A, a_ed_sk
    )
    head = record[:98]
    message = cck_record_message(CALENDAR_ID, USER_B, 1, head)
    open_inputs = {
        "record_hex": record.hex(),
        "calendar_id": CALENDAR_ID,
        "epoch": 1,
        "recipient_user_id": USER_B,
        "x25519_sk_hex": B_X25519_SEED.hex(),
        "signer_ed25519_pk_hex": a_ed_pk.hex(),
    }

    def moved(vid, purpose, **overrides):
        return negative(vid, "§6.6", purpose, dict(open_inputs, **overrides), "E_SIGNATURE")

    mis_sealed_head = bytes([0x01, 0x01]) + uuid_bytes(USER_A) + seal_box(
        TEST_CCK, c_x25519_pk, SEAL_EPHEMERAL_SEED
    )
    mis_sealed = mis_sealed_head + sign_detached(
        cck_record_message(CALENDAR_ID, USER_B, 1, mis_sealed_head), a_ed_sk
    )

    return [
        positive(
            "cck-record-seal-basic",
            "§6.6",
            "One record per member per epoch: the CCK sealed to the member and signed by the sender.",
            {
                "cck_hex": TEST_CCK.hex(),
                "calendar_id": CALENDAR_ID,
                "epoch": 1,
                "recipient_user_id": USER_B,
                "recipient_x25519_pk_hex": b_x25519_pk.hex(),
                "signer_user_id": USER_A,
                "signer_ed25519_seed_hex": A_ED25519_SEED.hex(),
            },
            {
                "record_hex": record.hex(),
                "record_bytes": CCK_RECORD_LENGTH,
                "signature_message_hex": message.hex(),
                "signer_user_id": USER_A,
            },
        ),
        positive(
            "cck-record-open-basic",
            "§6.6",
            "The recipient verifies the signature, then opens the sealed box.",
            open_inputs,
            {"cck_hex": TEST_CCK.hex(), "signer_user_id": USER_A},
        ),
        moved(
            "cck-record-wrong-calendar",
            "A record moved to another calendar fails the signature (D-14's spirit for records).",
            calendar_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ),
        moved(
            "cck-record-wrong-epoch",
            "A record moved to another epoch fails the signature.",
            epoch=2,
        ),
        moved(
            "cck-record-wrong-recipient",
            "A record moved onto another member's row fails the signature: the recipient is signed.",
            recipient_user_id=USER_C,
        ),
        moved(
            "cck-record-signature-flipped",
            "One bit of the signature flipped.",
            record_hex=flip(record, 100).hex(),
        ),
        moved(
            "cck-record-signer-key-substituted",
            "A server-substituted identity key fails the signature (D-15).",
            signer_ed25519_pk_hex=c_ed_pk.hex(),
        ),
        negative(
            "cck-record-sealed-to-other-key",
            "§6.6",
            "Signed for the right recipient but sealed to another key: the signature passes, the seal does not.",
            dict(open_inputs, record_hex=mis_sealed.hex()),
            "E_AUTH",
        ),
        negative(
            "cck-record-truncated",
            "§6.6",
            "161 bytes is not the pinned 162.",
            dict(open_inputs, record_hex=record[:161].hex()),
            "E_LENGTH",
        ),
        negative(
            "cck-record-version-02",
            "§6.6",
            "Version 0x02 is unknown.",
            dict(open_inputs, record_hex=(b"\x02" + record[1:]).hex()),
            "E_VERSION",
        ),
        negative(
            "cck-record-suite-02",
            "§6.6",
            "Suite 0x02 is not this version's seal-and-sign pair.",
            dict(open_inputs, record_hex=(record[:1] + b"\x02" + record[2:]).hex()),
            "E_UNSUPPORTED",
        ),
    ]


# --------------------------------------------------------------------------------------------
# device-link-v1.json
# --------------------------------------------------------------------------------------------


def link_vectors() -> list[dict]:
    a_ed_pk, a_ed_sk = bindings.crypto_sign_seed_keypair(A_ED25519_SEED)
    c_ed_pk, _ = bindings.crypto_sign_seed_keypair(C_ED25519_SEED)
    ephemeral_pk = bindings.crypto_scalarmult_base(EPHEMERAL_SEED)
    other_ephemeral_pk = bindings.crypto_scalarmult_base(bytes([0x77]) * 32)
    code = link_code(ephemeral_pk, a_ed_pk)
    uri = link_uri(LINK_ID, ephemeral_pk, code)
    bundle = key_bundle(A_X25519_SEED, a_ed_sk)
    blob = seal_link_bundle(USER_A, LINK_ID, ephemeral_pk, bundle, a_ed_sk)
    head = blob[:203]
    message = link_bundle_message(USER_A, LINK_ID, ephemeral_pk, head)
    open_inputs = {
        "blob_hex": blob.hex(),
        "user_id": USER_A,
        "link_id": LINK_ID,
        "ephemeral_sk_hex": EPHEMERAL_SEED.hex(),
        "signer_ed25519_pk_hex": a_ed_pk.hex(),
    }
    mis_sealed = seal_link_bundle(USER_A, LINK_ID, other_ephemeral_pk, bundle, a_ed_sk)

    return [
        positive(
            "link-code-basic",
            "§6.7",
            "The six digits both screens show: a hash of the new device's ephemeral key and the user's identity key.",
            {"ephemeral_pk_hex": ephemeral_pk.hex(), "identity_pk_hex": a_ed_pk.hex()},
            {"code": code, "digits": 6},
        ),
        positive(
            "link-qr-basic",
            "§6.7",
            "The QR payload the new device shows.",
            {"link_id": LINK_ID, "ephemeral_pk_hex": ephemeral_pk.hex(), "code": code},
            {"uri": uri, "ascii_bytes": len(uri)},
        ),
        positive(
            "link-qr-parse-basic",
            "§6.7",
            "Parsing it back gives the same three values.",
            {"uri": uri},
            {"link_id": LINK_ID, "ephemeral_pk_hex": ephemeral_pk.hex(), "code": code},
        ),
        negative(
            "link-qr-version-2",
            "§6.7",
            "Path version 2 is unknown.",
            {"uri": uri.replace("calflex://link/1?", "calflex://link/2?")},
            "E_VERSION",
        ),
        negative(
            "link-qr-code-mismatch",
            "§6.7",
            "A code that does not match the keys: the user must see the mismatch and stop.",
            {
                "uri": uri,
                "ephemeral_pk_hex": ephemeral_pk.hex(),
                "identity_pk_hex": a_ed_pk.hex(),
            },
            "E_VERIFY",
        ),
        negative(
            "link-qr-padded-key-refused",
            "§6.7",
            "base64url inside a URI is unpadded.",
            {"uri": uri.replace("&c=", "=&c=")},
            "E_ENCODING",
        ),
        negative(
            "link-qr-unknown-param",
            "§6.7",
            "A parameter outside `l`, `e`, `c` is refused.",
            {"uri": uri + "&z=1"},
            "E_VERIFY",
        ),
        negative(
            "link-qr-bad-uuid",
            "§6.7",
            "The rendezvous id is a lowercase UUIDv4.",
            {"uri": uri.replace(LINK_ID, LINK_ID.upper())},
            "E_ENCODING",
        ),
        positive(
            "link-bundle-seal-basic",
            "§6.7",
            "The private keys sealed to the new device's ephemeral key and signed by the linking device.",
            {
                "user_id": USER_A,
                "link_id": LINK_ID,
                "recipient_ephemeral_pk_hex": ephemeral_pk.hex(),
                "bundle_hex": bundle.hex(),
                "signer_ed25519_seed_hex": A_ED25519_SEED.hex(),
            },
            {
                "blob_hex": blob.hex(),
                "blob_bytes": LINK_BUNDLE_LENGTH,
                "signature_message_hex": message.hex(),
            },
        ),
        positive(
            "link-bundle-open-basic",
            "§6.7",
            "The new device verifies the signature and opens the bundle.",
            open_inputs,
            {"bundle_hex": bundle.hex(), "x25519_sk_hex": A_X25519_SEED.hex()},
        ),
        negative(
            "link-bundle-wrong-link",
            "§6.7",
            "A blob replayed at another rendezvous fails the signature.",
            dict(open_inputs, link_id="44444444-4444-4444-8444-444444444445"),
            "E_SIGNATURE",
        ),
        negative(
            "link-bundle-wrong-ephemeral",
            "§6.7",
            "A blob replayed at another ephemeral key fails the signature.",
            dict(
                open_inputs,
                blob_hex=seal_link_bundle(
                    USER_A,
                    LINK_ID,
                    other_ephemeral_pk,
                    bundle,
                    a_ed_sk,
                ).hex(),
                ephemeral_sk_hex=EPHEMERAL_SEED.hex(),
            ),
            "E_SIGNATURE",
        ),
        negative(
            "link-bundle-signer-substituted",
            "§6.7",
            "A substituted identity key fails the signature (D-15).",
            dict(open_inputs, signer_ed25519_pk_hex=c_ed_pk.hex()),
            "E_SIGNATURE",
        ),
        negative(
            "link-bundle-signature-flipped",
            "§6.7",
            "One bit of the signature flipped.",
            dict(open_inputs, blob_hex=flip(blob, 210).hex()),
            "E_SIGNATURE",
        ),
        negative(
            "link-bundle-sealed-to-other-key",
            "§6.7",
            "Signed for this link but sealed to another ephemeral key: the seal refuses it.",
            dict(open_inputs, blob_hex=mis_sealed.hex()),
            "E_AUTH",
        ),
        negative(
            "link-bundle-truncated",
            "§6.7",
            "266 bytes is not the pinned 267.",
            dict(open_inputs, blob_hex=blob[:266].hex()),
            "E_LENGTH",
        ),
    ]


# --------------------------------------------------------------------------------------------
# identity-v1.json
# --------------------------------------------------------------------------------------------


def identity_vectors() -> list[dict]:
    a_x25519_pk = bindings.crypto_scalarmult_base(A_X25519_SEED)
    a_ed_pk, _ = bindings.crypto_sign_seed_keypair(A_ED25519_SEED)
    b_x25519_pk = bindings.crypto_scalarmult_base(B_X25519_SEED)
    b_ed_pk, _ = bindings.crypto_sign_seed_keypair(B_ED25519_SEED)
    fingerprint_a = fingerprint(a_x25519_pk, a_ed_pk)
    fingerprint_b = fingerprint(b_x25519_pk, b_ed_pk)
    number = safety_number(fingerprint_a, fingerprint_b)
    uri = verify_uri(USER_A, a_ed_pk, a_x25519_pk)
    grouped_fingerprint = " ".join(
        fingerprint_a.hex()[index : index + 8] for index in range(0, 64, 8)
    )
    grouped_number = " ".join(number[index : index + 5] for index in range(0, 60, 5))

    return [
        positive(
            "identity-fingerprint-basic",
            "§6.8",
            "The fingerprint covers both public keys, so a substituted sealing key is visible too.",
            {"x25519_pk_hex": a_x25519_pk.hex(), "ed25519_pk_hex": a_ed_pk.hex()},
            {
                "fingerprint_hex": fingerprint_a.hex(),
                "hex_digits": 64,
                "grouped": grouped_fingerprint,
                "label": "calflex-id-v1",
                "message_hex": (LABEL_ID + a_x25519_pk + a_ed_pk).hex(),
            },
        ),
        positive(
            "identity-fingerprint-differs-for-other-keys",
            "§6.8",
            "Another sealing key gives another fingerprint.",
            {"x25519_pk_hex": b_x25519_pk.hex(), "ed25519_pk_hex": a_ed_pk.hex()},
            {"fingerprint_hex": fingerprint(b_x25519_pk, a_ed_pk).hex()},
            differs_from="identity-fingerprint-basic",
        ),
        positive(
            "identity-safety-number-basic",
            "§6.8",
            "Sixty digits, twelve groups of five, computed from the two fingerprints.",
            {"first_fingerprint_hex": fingerprint_a.hex(), "second_fingerprint_hex": fingerprint_b.hex()},
            {"safety_number": number, "digits": 60, "grouped": grouped_number},
        ),
        positive(
            "identity-safety-number-order-independent",
            "§6.8",
            "The fingerprints are sorted before hashing, so both users read the same number.",
            {"first_fingerprint_hex": fingerprint_b.hex(), "second_fingerprint_hex": fingerprint_a.hex()},
            {"safety_number": number, "digits": 60, "grouped": grouped_number},
            same_as="identity-safety-number-basic",
        ),
        positive(
            "identity-verify-qr-basic",
            "§6.8",
            "The in-person verification payload: both public keys and the fingerprint that covers them.",
            {"user_id": USER_A, "ed25519_pk_hex": a_ed_pk.hex(), "x25519_pk_hex": a_x25519_pk.hex()},
            {"uri": uri, "ascii_bytes": len(uri)},
        ),
        positive(
            "identity-verify-qr-parse-basic",
            "§6.8",
            "A scanner recomputes the fingerprint and accepts the code.",
            {"uri": uri},
            {
                "user_id": USER_A,
                "ed25519_pk_hex": a_ed_pk.hex(),
                "x25519_pk_hex": a_x25519_pk.hex(),
                "fingerprint_hex": fingerprint_a.hex(),
            },
        ),
        negative(
            "identity-verify-qr-fingerprint-mismatch",
            "§6.8",
            "`f` that is not the fingerprint of `k` and `x` is refused, not repaired.",
            {"uri": uri.replace(fingerprint_a.hex(), fingerprint_b.hex())},
            "E_VERIFY",
        ),
        negative(
            "identity-verify-qr-uppercase-fingerprint",
            "§6.8",
            "The fingerprint is lowercase hex.",
            {"uri": uri.replace(fingerprint_a.hex(), fingerprint_a.hex().upper())},
            "E_ENCODING",
        ),
        negative(
            "identity-verify-qr-padded-key",
            "§6.8",
            "base64url without padding.",
            {"uri": uri.replace("&x=", "=&x=")},
            "E_ENCODING",
        ),
        negative(
            "identity-verify-qr-unknown-param",
            "§6.8",
            "A parameter outside `u`, `k`, `x`, `f` is refused.",
            {"uri": uri + "&z=1"},
            "E_VERIFY",
        ),
        negative(
            "identity-verify-qr-version-2",
            "§6.8",
            "Path version 2 is unknown.",
            {"uri": uri.replace("calflex://verify/1?", "calflex://verify/2?")},
            "E_VERSION",
        ),
        negative(
            "identity-verify-qr-bad-uuid",
            "§6.8",
            "The user id is a lowercase UUIDv4.",
            {"uri": uri.replace(USER_A, USER_A.upper())},
            "E_ENCODING",
        ),
    ]


# --------------------------------------------------------------------------------------------
# The operations a vector belongs to, and the spec item each one covers
# --------------------------------------------------------------------------------------------

OPS = sorted(
    [
        ("envelope-event-sha256", "skeleton_hash"),
        ("envelope-event-seal", "seal_event"),
        ("envelope-event-open", "open_event"),
        ("envelope-seal", "seal_event"),
        ("envelope-open", "open_event"),
        ("aad-from-skeleton", "build_aad"),
        ("aad-event", "build_aad"),
        ("aad-uid", "build_aad"),
        ("aad-diff", "build_aad"),
        ("aad-epoch", "build_aad"),
        ("aad-calendar-id", "build_aad"),
        ("aad-label", "constants"),
        ("timing-", "canonical_timing"),
        ("jcs-", "jcs_dumps"),
        ("payload-", "validate_payload"),
        ("metadata-seal", "seal_metadata"),
        ("metadata-open", "open_metadata"),
        ("metadata-aad", "build_aad"),
        ("event-open-as-metadata", "open_metadata"),
        ("recovery-phrase-bip39", "recovery_phrase"),
        ("recovery-phrase-from-entropy", "recovery_phrase"),
        ("recovery-phrase-to-entropy", "parse_recovery_phrase"),
        ("recovery-phrase-", "parse_recovery_phrase"),
        ("recovery-kek", "recovery_kek"),
        ("key-bundle-tlv", "key_bundle"),
        ("key-bundle-public-keys-match", "check_key_bundle"),
        ("key-bundle-public-key-mismatch", "check_key_bundle"),
        ("key-bundle-wrong-length", "key_bundle"),
        ("wrapped-key-seal", "seal_wrapped_key"),
        ("wrapped-key-open", "open_wrapped_key"),
        ("identity-keys-from-seeds", "identity_keys"),
        ("cck-record-seal", "seal_cck_record"),
        ("cck-record-", "open_cck_record"),
        ("link-code", "link_code"),
        ("link-qr-parse", "parse_link_uri"),
        ("link-qr-basic", "link_uri"),
        ("link-qr-", "parse_link_uri"),
        ("link-bundle-seal", "seal_link_bundle"),
        ("link-bundle-", "open_link_bundle"),
        ("identity-fingerprint", "fingerprint"),
        ("identity-safety-number", "safety_number"),
        ("identity-verify-qr-parse", "parse_verify_uri"),
        ("identity-verify-qr-basic", "verify_uri"),
        ("identity-verify-qr-", "parse_verify_uri"),
    ],
    key=lambda pair: -len(pair[0]),
)


def op_for(vid: str) -> str:
    for prefix, op in OPS:
        if vid.startswith(prefix):
            return op
    raise SystemExit(f"no operation is mapped for vector {vid}")


VECTOR_INDEX = {
    "envelope header: version, epoch, nonce, ciphertext, tag (E12-R01 bullet 1, ADR 0001 layout)": [
        "envelope-event-seal-basic",
        "envelope-event-open-basic",
        "envelope-event-seal-epoch-max",
        "envelope-event-seal-epoch-zero",
        "envelope-seal-epoch-over-max",
        "envelope-seal-epoch-negative",
        "envelope-open-empty",
        "envelope-open-44-bytes",
        "envelope-open-version-02",
        "envelope-open-epoch-over-max",
        "envelope-open-tag-flipped",
        "envelope-open-ciphertext-flipped",
        "envelope-open-nonce-flipped",
        "envelope-open-truncated",
        "envelope-open-wrong-cck",
    ],
    "canonical AAD: label, length-prefixed fixed-order fields, D-14's calendar_id and recurrence_id": [
        "aad-event-master",
        "aad-from-skeleton-master",
        "aad-event-override",
        "aad-uid-multibyte",
        "aad-uid-embedded-nul",
        "aad-event-uid-text-unescaped",
        "aad-diff-uid",
        "aad-diff-calendar-id",
        "aad-diff-epoch",
        "aad-diff-recurrence-id",
        "aad-diff-dtstart",
        "aad-diff-end",
        "aad-diff-rrule",
        "aad-diff-tzid-spelling",
        "aad-epoch-max-decimal",
        "aad-label-byte-8",
        "aad-calendar-id-uppercase-refused",
        "aad-calendar-id-not-v4-refused",
        "aad-uid-empty-refused",
        "aad-epoch-over-max-refused",
        "envelope-open-aad-uid-changed",
        "envelope-open-aad-calendar-changed",
        "envelope-open-aad-recurrence-changed",
    ],
    "payload: JSCalendar field names serialised with JCS (E12-R01 bullet 3)": [
        "jcs-member-order",
        "jcs-string-escapes",
        "jcs-integers",
        "jcs-no-whitespace",
        "jcs-astral-member-order",
        "payload-event-basic",
        "payload-calendar-basic",
        "payload-event-forbidden-uid-refused",
        "payload-event-forbidden-start-refused",
        "payload-event-forbidden-alerts-refused",
        "payload-event-unknown-member-refused",
        "payload-event-null-refused",
        "payload-event-float-refused",
        "payload-event-missing-type-refused",
        "payload-event-wrong-type-refused",
        "payload-event-top-level-array-refused",
        "payload-event-duplicate-member-refused",
        "payload-event-not-jcs-refused",
        "payload-event-not-utf8-refused",
        "payload-calendar-no-name-refused",
        "payload-calendar-extra-member-refused",
        "payload-calendar-uppercase-color-refused",
        "payload-calendar-short-color-refused",
        "envelope-seal-payload-forbidden-member",
        "envelope-seal-payload-null",
        "envelope-seal-payload-missing-type",
        "envelope-seal-payload-float",
        "envelope-open-payload-not-jcs",
        "envelope-open-payload-duplicate-member",
        "envelope-open-payload-wrong-type",
    ],
    "wrapped private keys, sealed CCK records, the recovery code and the device-link message (E12-R01 bullets 4 and 5)": [
        "recovery-phrase-bip39-official-1",
        "recovery-phrase-bip39-official-2",
        "recovery-phrase-from-entropy",
        "recovery-phrase-to-entropy",
        "recovery-kek-basic",
        "recovery-phrase-bad-checksum-refused",
        "recovery-phrase-unknown-word-refused",
        "recovery-phrase-eleven-words-refused",
        "key-bundle-tlv-basic",
        "key-bundle-public-keys-match",
        "key-bundle-public-key-mismatch-refused",
        "key-bundle-wrong-length-refused",
        "identity-keys-from-seeds",
        "wrapped-key-seal-basic",
        "wrapped-key-open-basic",
        "wrapped-key-open-wrong-user",
        "wrapped-key-open-caller-kind-mismatch",
        "wrapped-key-open-escrow-kind-reserved",
        "wrapped-key-open-version-02",
        "wrapped-key-open-truncated",
        "wrapped-key-open-over-512-refused",
        "wrapped-key-open-tag-flipped",
        "cck-record-seal-basic",
        "cck-record-open-basic",
        "cck-record-wrong-calendar",
        "cck-record-wrong-epoch",
        "cck-record-wrong-recipient",
        "cck-record-signature-flipped",
        "cck-record-signer-key-substituted",
        "cck-record-sealed-to-other-key",
        "cck-record-truncated",
        "cck-record-version-02",
        "cck-record-suite-02",
        "link-code-basic",
        "link-qr-basic",
        "link-qr-parse-basic",
        "link-qr-version-2",
        "link-qr-code-mismatch",
        "link-qr-padded-key-refused",
        "link-qr-unknown-param",
        "link-qr-bad-uuid",
        "link-bundle-seal-basic",
        "link-bundle-open-basic",
        "link-bundle-wrong-link",
        "link-bundle-wrong-ephemeral",
        "link-bundle-signer-substituted",
        "link-bundle-signature-flipped",
        "link-bundle-sealed-to-other-key",
        "link-bundle-truncated",
    ],
    "calendar-metadata envelope (D-18)": [
        "metadata-seal-basic",
        "metadata-open-basic",
        "metadata-open-as-event",
        "event-open-as-metadata",
        "metadata-aad-diff-epoch",
        "metadata-aad-diff-calendar",
        "metadata-seal-over-4096-refused",
    ],
    "skeleton bindings: X-CALFLEX-ENVELOPE-SHA256, the canonical recurrence_id, the bound timing, RDATE/EXDATE": [
        "envelope-event-sha256-basic",
        "envelope-event-sha256-flipped-differs",
        "envelope-event-sha256-uppercase-refused",
        "envelope-event-sha256-short-refused",
        "timing-recurrence-id-two-spellings-utc",
        "timing-recurrence-id-two-spellings-tzid",
        "timing-recurrence-id-date",
        "timing-recurrence-id-floating-refused",
        "timing-dtstart-date",
        "timing-dtstart-utc",
        "timing-dtstart-zoned",
        "timing-dtstart-zoned-link-name",
        "timing-dtstart-floating-refused",
        "timing-dtstart-leap-second-refused",
        "timing-dtstart-bad-date-refused",
        "timing-dtstart-missing-refused",
        "timing-end-duration",
        "timing-end-none",
        "timing-end-both-refused",
        "timing-duration-negative",
        "timing-duration-zero",
        "timing-duration-sixty-minutes",
        "timing-duration-weeks",
        "timing-duration-mixed-week-refused",
        "timing-duration-missing-unit-refused",
        "timing-rrule-interval-one-dropped",
        "timing-rrule-plain-count",
        "timing-rrule-byday-sorted",
        "timing-rrule-numeric-list-sorted",
        "timing-rrule-part-order",
        "timing-rrule-until-utc",
        "timing-rrule-until-date",
        "timing-rrule-none",
        "timing-rrule-x-part-refused",
        "timing-rrule-duplicate-part-refused",
        "timing-rrule-missing-freq-refused",
        "timing-rrule-out-of-range-refused",
        "timing-rrule-until-and-count-refused",
        "timing-dst-europe-berlin-spring-skipped",
        "timing-dst-europe-berlin-autumn-repeated",
        "timing-dst-daily-skipped-instance",
        "aad-event-rdate-exdate-not-bound",
        "envelope-open-aad-dtstart-changed",
        "envelope-open-aad-end-changed",
        "envelope-open-aad-rrule-changed",
    ],
    "identity key: fingerprint, safety number, verification QR payload (D-15)": [
        "identity-fingerprint-basic",
        "identity-fingerprint-differs-for-other-keys",
        "identity-safety-number-basic",
        "identity-safety-number-order-independent",
        "identity-verify-qr-basic",
        "identity-verify-qr-parse-basic",
        "identity-verify-qr-fingerprint-mismatch",
        "identity-verify-qr-uppercase-fingerprint",
        "identity-verify-qr-padded-key",
        "identity-verify-qr-unknown-param",
        "identity-verify-qr-version-2",
        "identity-verify-qr-bad-uuid",
    ],
}


# --------------------------------------------------------------------------------------------
# Self-checks, cross-references and the writer
# --------------------------------------------------------------------------------------------


def self_checks() -> None:
    # RFC 5869 A.1 and A.3, the same values the E12-R02 probe asserts.
    ikm = bytes.fromhex("0b" * 22)
    okm1 = hkdf_sha256(
        ikm,
        bytes.fromhex("000102030405060708090a0b0c"),
        bytes.fromhex("f0f1f2f3f4f5f6f7f8f9"),
        42,
    )
    assert okm1.hex() == (
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    ), okm1.hex()
    okm3 = hkdf_sha256(ikm, b"", b"", 42)
    assert okm3.hex() == (
        "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
    ), okm3.hex()
    for entropy_hex, phrase in BIP39_VECTORS:
        assert recovery_phrase(bytes.fromhex(entropy_hex)) == phrase
        assert parse_recovery_phrase(phrase).hex() == entropy_hex
    assert sha256(WORDLIST_BYTES).hex() == PINNED_WORDLIST_SHA256
    recipient_sk = B_X25519_SEED
    recipient_pk = bindings.crypto_scalarmult_base(recipient_sk)
    pinned = seal_box(b"sealed box check", recipient_pk, SEAL_EPHEMERAL_SEED)
    assert bindings.crypto_box_seal_open(pinned, recipient_pk, recipient_sk) == b"sealed box check"
    fresh = bindings.crypto_box_seal(b"sealed box check", recipient_pk)
    assert bindings.crypto_box_seal_open(fresh, recipient_pk, recipient_sk) == b"sealed box check"
    assert len(fresh) == len(pinned), (len(fresh), len(pinned))
    assert pinned != seal_box(b"sealed box check", recipient_pk, LINK_SEAL_EPHEMERAL_SEED)
    print("self-checks: HKDF-SHA-256 (RFC 5869 A.1, A.3) ok, BIP-0039 official vectors ok")
    print(
        "self-checks: the fixed-ephemeral sealed box opens with libsodium's crypto_box_seal_open"
    )
    print(f"self-checks: BIP-0039 english.txt sha256 {PINNED_WORDLIST_SHA256} ok")
    check_dst_against_cases()


def check_dst_against_cases() -> None:
    cases_path = HERE.parent.parent / "ical-fixtures" / "dst" / "cases.json"
    if not cases_path.exists():
        print(f"self-checks: {cases_path} is missing, DST cross-check skipped")
        return
    cases = {case["id"]: case for case in json.loads(cases_path.read_text("utf-8"))["cases"]}
    checked = 0
    for case_id, computed in (
        ("berlin-2026-spring-skipped", instant_of_time_field("zoned:Europe/Berlin@20260329T023000")),
        ("berlin-2026-fall-repeated", instant_of_time_field("zoned:Europe/Berlin@20261025T023000")),
    ):
        expected = cases[case_id]["expected"]
        assert computed == expected[0], (case_id, computed, expected)
        checked += 1
    case = cases["berlin-2026-spring-daily-skipped"]
    computed = expand_daily_skipped(
        case["zone"], case["input"]["dtstart"], case["input"]["rrule"]["count"]
    )
    assert computed == case["expected"], (computed, case["expected"])
    checked += 1
    print(f"self-checks: {checked} DST cases match spec/ical-fixtures/dst/cases.json")


def build_documents() -> dict[str, dict]:
    return {
        "envelope-v1.json": envelope_vectors(),
        "aad-v1.json": aad_vectors(),
        "canonical-timing-v1.json": timing_vectors(),
        "payload-jcs-v1.json": payload_vectors(),
        "metadata-envelope-v1.json": metadata_vectors(),
        "keys-v1.json": key_vectors(),
        "cck-records-v1.json": cck_vectors(),
        "device-link-v1.json": link_vectors(),
        "identity-v1.json": identity_vectors(),
    }


def verify_index(documents: dict[str, dict]) -> None:
    ids = [vector["id"] for vectors in documents.values() for vector in vectors]
    indexed = [vid for group in VECTOR_INDEX.values() for vid in group]
    missing = [vid for vid in ids if vid not in indexed]
    unknown = [vid for vid in indexed if vid not in ids]
    duplicated = [vid for vid in set(indexed) if indexed.count(vid) > 1]
    if missing or unknown or duplicated:
        raise SystemExit(
            f"VECTOR_INDEX is not complete: missing={sorted(missing)!r} unknown={sorted(unknown)!r} duplicated={sorted(duplicated)!r}"
        )


PRIMARY_KEYS = [
    "aad_hex",
    "envelope_hex",
    "jcs",
    "safety_number",
    "fingerprint_hex",
    "code",
    "uri",
    "envelope_sha256_hex",
    "blob_hex",
    "record_hex",
    "wrapped_key_hex",
    "bundle_hex",
]


def primary_of(vector: dict):
    for key in PRIMARY_KEYS:
        if key in vector.get("expected", {}):
            return key, vector["expected"][key]
    return None, None


def verify_cross_references(documents: dict[str, dict]) -> None:
    for filename, vectors in documents.items():
        by_id = {vector["id"]: vector for vector in vectors}
        for vector in vectors:
            for relation in ("same_as", "differs_from"):
                if relation not in vector:
                    continue
                other = by_id.get(vector[relation])
                if other is None:
                    raise SystemExit(
                        "{}: {} references an unknown vector {}".format(vector["id"], relation, vector[relation])
                    )
                key, mine = primary_of(vector)
                other_key, theirs = primary_of(other)
                if mine is None or theirs is None or key != other_key:
                    raise SystemExit(
                        "{}: {} compares {!r} with {!r}".format(vector["id"], relation, key, other_key)
                    )
                if relation == "same_as" and mine != theirs:
                    raise SystemExit("{}: {} does not hold".format(vector["id"], relation))
                if relation == "differs_from" and mine == theirs:
                    raise SystemExit("{}: {} does not hold".format(vector["id"], relation))
        print(f"cross-references ok in {filename}")


def cross_check_jcs(documents: dict[str, dict]) -> None:
    checked = 0
    try:
        import rfc8785  # noqa: F401
    except ImportError:
        print("jcs cross-check: rfc8785 is not installed, skipped (the vectors are unchanged)")
        return
    for vectors in documents.values():
        for vector in vectors:
            for key in ("object", "payload_object"):
                if key not in vector["inputs"]:
                    continue
                try:
                    jcs.compare_with_rfc8785(vector["inputs"][key])
                except ValueError:
                    # A vector that deliberately carries a float or an out-of-range integer is
                    # about the *refusal*, so there is nothing to compare.
                    continue
                checked += 1
    print(f"jcs cross-check: {checked} objects agree with rfc8785 0.1.4")


def annotate(documents: dict[str, dict]) -> None:
    for vectors in documents.values():
        for vector in vectors:
            vector["op"] = op_for(vector["id"])


def serialise(documents: dict[str, dict]) -> dict[str, str]:
    out = {}
    for filename, vectors in documents.items():
        document = {
            "file": filename,
            "format": VECTORS_FORMAT,
            "generator": "spec/crypto-vectors/gen/generate.py",
            "note": NOTE,
            "spec": SPEC,
            "vectors": vectors,
        }
        out[filename] = json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    return out


def write_all(rendered: dict[str, str], target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for filename, text in rendered.items():
        (target / filename).write_text(text, encoding="utf-8")


def compare_with_committed(rendered: dict[str, str], target: Path) -> list[str]:
    problems = []
    for filename, text in rendered.items():
        path = target / filename
        if not path.exists():
            problems.append(f"{filename} is missing")
        elif path.read_text(encoding="utf-8") != text:
            problems.append(f"{filename} differs from the generator's output")
    for path in sorted(target.glob("*.json")):
        if path.name not in rendered:
            problems.append(f"{path.name} is committed but no longer generated")
    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="regenerate into a scratch directory and fail if the committed vectors differ",
    )
    parser.add_argument("--out", default=None, help="write somewhere other than the vectors directory")
    args = parser.parse_args(argv)

    self_checks()
    documents = build_documents()
    annotate(documents)
    verify_index(documents)
    verify_cross_references(documents)
    cross_check_jcs(documents)
    rendered = serialise(documents)

    total = sum(len(vectors) for vectors in documents.values())
    for filename, vectors in documents.items():
        negatives = sum(1 for vector in vectors if vector["kind"] == "negative")
        print(f"{filename:<28} {len(vectors):3d} vectors ({negatives} negative)")
    print(f"{total} vectors in {len(documents)} files")

    if args.check:
        with tempfile.TemporaryDirectory() as scratch:
            write_all(rendered, Path(scratch))
            problems = compare_with_committed(rendered, OUT_DIR)
        if problems:
            print("check FAILED:", file=sys.stderr)
            for problem in problems:
                print(f"  {problem}", file=sys.stderr)
            return 1
        print("check ok: every committed vector file is byte-identical to a fresh generation")
        return 0

    target = Path(args.out) if args.out else OUT_DIR
    write_all(rendered, target)
    print(f"wrote {len(rendered)} files to {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
