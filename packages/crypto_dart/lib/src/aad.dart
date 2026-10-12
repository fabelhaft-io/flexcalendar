/// The canonical AAD of `spec/crypto.md` §2: the only thing that binds an
/// envelope to its calendar, its event, its override and its epoch.
///
/// It is a framed message (§2.1): a domain label, then length-prefixed UTF-8
/// fields **in a fixed order**, with no optional fields and no absent field. The
/// two labels differ in byte 8 (`v` vs `m`), so no choice of field bytes can make
/// an event AAD equal a calendar-metadata one: opening a metadata envelope with
/// the event AAD, or the reverse, fails `E_AUTH` (D-18).
///
/// Field 4 of the event AAD is the epoch of the envelope *header*, which is what
/// makes §1.3 step 4's rule enforceable: the AAD is built from the values the
/// caller handed to `seal`/`open` plus the epoch the bytes carry, never from a
/// separate epoch argument.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'errors.dart';
import 'timing.dart';

/// The AAD label of an event envelope (§2.2).
const String eventAadLabel = 'calflex-v1';

/// The AAD label of a calendar-metadata envelope (§2.3).
const String calendarMetadataAadLabel = 'calflex-meta-v1';

/// The only envelope version this implementation writes or reads (§1.1).
const int envelopeVersion = 0x01;

/// `1 + 4 + 24 + 16`: version, epoch, nonce and tag (§1.1).
const int envelopeFixedBytes = 45;

/// The 24-byte XChaCha20 nonce (§1.1).
const int nonceBytes = 24;

/// The 16-byte Poly1305 tag (§1.1).
const int tagBytes = 16;

/// The 32-byte calendar content key (§1.1).
const int cckBytes = 32;

/// The client-side ceiling on an event envelope: 65 536 bytes (§1.1).
const int maxEventEnvelopeBytes = 65536;

/// The ceiling on a calendar-metadata envelope: 4096 bytes, enforced by the API
/// on create and rename (§1.1).
const int maxCalendarMetadataEnvelopeBytes = 4096;

/// `2^31 − 1`: the wire field is a `u32`, but Postgres' columns are `integer`.
const int maxEpoch = 2147483647;

/// The framing of §2.1: the domain label verbatim (it is **never**
/// length-prefixed), then one `lp32` field per element, in order.
Uint8List frame(String label, List<List<int>> fields) {
  var size = label.length;
  for (final field in fields) {
    size += 4 + field.length;
  }
  final out = Uint8List(size);
  final labelBytes = utf8.encode(label);
  out.setRange(0, labelBytes.length, labelBytes);
  var offset = labelBytes.length;
  for (final field in fields) {
    out[offset] = (field.length >> 24) & 0xff;
    out[offset + 1] = (field.length >> 16) & 0xff;
    out[offset + 2] = (field.length >> 8) & 0xff;
    out[offset + 3] = field.length & 0xff;
    out.setRange(offset + 4, offset + 4 + field.length, field);
    offset += 4 + field.length;
  }
  return out;
}

/// The values a `VEVENT`'s envelope binds: what the caller hands to `seal` and
/// `open`, plus the epoch the header carries.
///
/// [dtstart], [end] and [rrule] are the canonical §3 fields; build them with
/// [CanonicalTiming.fromProperties] so the AAD is a function of the parsed
/// skeleton rather than of its spelling.
class EventSkeleton {
  const EventSkeleton({
    required this.calendarId,
    required this.uid,
    required this.dtstart,
    required this.end,
    required this.rrule,
    this.recurrenceId,
  });

  /// Builds the skeleton from the skeleton's iCalendar content lines (§3).
  ///
  /// [recurrenceId] is optional — its absence is the master — and `DTSTART` and
  /// `UID` in the lines are not.
  factory EventSkeleton.fromProperties({
    required String calendarId,
    required List<String> properties,
    RecurrenceId? recurrenceId,
  }) {
    final timing = CanonicalTiming.fromProperties(
      properties,
      recurrenceId: recurrenceId,
    );
    return EventSkeleton(
      calendarId: calendarId,
      uid: timing.uid,
      dtstart: timing.dtstart,
      end: timing.end,
      rrule: timing.rrule,
      recurrenceId: recurrenceId,
    );
  }

  /// The owning calendar: a canonical lowercase UUIDv4.
  final String calendarId;

  /// The `VEVENT`'s `UID` value as parsed.
  final String uid;

  /// Canonical `DTSTART` (§3.1).
  final String dtstart;

  /// Canonical end: `DTEND`, `DURATION`, or the literal `none` (§3.2).
  final String end;

  /// Canonical `RRULE`, or the literal `none` (§3.3).
  final String rrule;

  /// The override this envelope belongs to, as the API reports it; absent for the
  /// master (§5.2).
  ///
  /// It is a [RecurrenceId], never the stored property text: a client addresses an
  /// occurrence with the value the API gave it (INV-05), and the canonical §5.2
  /// field of the AAD is computed from it here.
  final RecurrenceId? recurrenceId;

  /// The seven fields of §2.2, bound to [epoch].
  Uint8List aad(int epoch) {
    _checkUuidV4(calendarId);
    if (uid.isEmpty) {
      throw const CryptoException(
        CryptoError.skeleton,
        'the UID field may not be empty; only the master\'s recurrence_id may',
      );
    }
    _checkEpoch(epoch);
    return frame(eventAadLabel, [
      utf8.encode(calendarId),
      utf8.encode(uid),
      utf8.encode(canonicalRecurrenceId(recurrenceId)),
      utf8.encode(epoch.toString()),
      utf8.encode(dtstart),
      utf8.encode(end),
      utf8.encode(rrule),
    ]);
  }
}

/// The values a calendar-metadata envelope binds (§2.3, D-18).
class CalendarSkeleton {
  const CalendarSkeleton({required this.calendarId});

  /// The calendar whose name and colour are sealed: a canonical lowercase
  /// UUIDv4.
  final String calendarId;

  /// The two fields of §2.3, bound to [epoch].
  Uint8List aad(int epoch) {
    _checkUuidV4(calendarId);
    _checkEpoch(epoch);
    return frame(calendarMetadataAadLabel, [
      utf8.encode(calendarId),
      utf8.encode(epoch.toString()),
    ]);
  }
}

/// The epoch range every format in `spec/crypto.md` shares (§1.1).
void checkEpoch(int epoch) => _checkEpoch(epoch);

void _checkEpoch(int epoch) {
  if (epoch < 0 || epoch > maxEpoch) {
    throw CryptoException(CryptoError.epoch, 'an epoch outside 0 … $maxEpoch');
  }
}

final RegExp _uuidV4 = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
);

void _checkUuidV4(String value) {
  if (!_uuidV4.hasMatch(value)) {
    throw const CryptoException(
      CryptoError.encoding,
      'an identifier that is not a canonical lowercase UUIDv4',
    );
  }
}
