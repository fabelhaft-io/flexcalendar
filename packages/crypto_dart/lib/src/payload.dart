import 'dart:convert';
import 'dart:typed_data';

import 'errors.dart';
import 'jcs.dart';
import 'json_strict.dart';

/// Which §4 rule set a payload is held to.
enum PayloadKind {
  /// §4.2: a `VEVENT`'s content.
  event,

  /// §4.3: a Private calendar's name and colour (D-18).
  calendar,
}

/// The member names §4.2 allows, besides `@type`.
///
/// The list is complete for version 1: a member outside it is `E_PAYLOAD` at
/// seal **and** at open, so adding one is a version bump rather than a silent
/// divergence between the two libraries.
const Set<String> eventPayloadMembers = {
  'title',
  'description',
  'descriptionContentType',
  'locations',
  'virtualLocations',
  'links',
  'participants',
  'replyTo',
  'keywords',
  'categories',
  'locale',
  'priority',
  'freeBusyStatus',
  'status',
  'color',
  'relatedTo',
};

/// The member names §4.3 allows, besides `@type`.
const Set<String> calendarPayloadMembers = {'name', 'color'};

/// RFC 7986 §3.1 colour: `#` and six or eight lowercase hex digits.
final RegExp _colour = RegExp(r'^#[0-9a-f]{6}([0-9a-f]{2})?$');

/// Serialises [payload] to its JCS bytes and validates it per §4.
///
/// Throws [CryptoException] with `E_PAYLOAD` for anything §4 refuses.
Uint8List serialisePayload(
  Map<String, Object?> payload,
  PayloadKind kind, {
  bool checkCalendarValues = true,
}) {
  final Uint8List bytes;
  try {
    bytes = jcsEncode(payload);
  } on JcsUnsupported catch (error) {
    throw CryptoException(CryptoError.payload, error.message);
  }
  validatePayloadStructure(
    bytes,
    kind,
    checkCalendarValues: checkCalendarValues,
  );
  return bytes;
}

/// Validates payload [bytes] per §4 and returns the parsed object.
///
/// The plaintext of an envelope is the JCS serialisation of a JSON object
/// (§4.1), so "valid" means: UTF-8, no repeated member name at any depth, a JSON
/// object, byte-for-byte equal to its own JCS serialisation, no `null` member, no
/// number that is not an integer in the safe range, `@type` as §4.2/§4.3 require,
/// and only members of the applicable allow-list.
Map<String, Object?> validatePayload(Uint8List bytes, PayloadKind kind) =>
    validatePayloadStructure(bytes, kind, checkCalendarValues: true);

/// [validatePayload] with the §4.3 value rules (`name`, `color`) switchable.
///
/// `sealCalendarMetadata` uses this to check the payload's *shape* before it
/// checks the envelope's size ceiling: the frozen vector
/// `metadata-seal-over-4096-refused` pins `E_LENGTH` for a metadata payload that
/// is both oversized and has a 4200-byte name, so the ceiling is reported first.
/// Not part of the library's public API.
Map<String, Object?> validatePayloadStructure(
  Uint8List bytes,
  PayloadKind kind, {
  required bool checkCalendarValues,
}) {
  final String text;
  try {
    text = utf8.decode(bytes);
  } on FormatException {
    throw const CryptoException(
      CryptoError.payload,
      'the plaintext is not valid UTF-8',
    );
  }
  final Object? value;
  try {
    value = jsonParseStrict(text);
  } on JsonStrictException catch (error) {
    throw CryptoException(CryptoError.payload, error.message);
  }
  final Uint8List canonical;
  try {
    canonical = jcsEncode(value);
  } on JcsUnsupported catch (error) {
    throw CryptoException(CryptoError.payload, error.message);
  }
  if (!_sameBytes(canonical, bytes)) {
    throw const CryptoException(
      CryptoError.payload,
      'the plaintext is not its own JCS serialisation',
    );
  }
  if (value is! Map<String, Object?>) {
    throw const CryptoException(
      CryptoError.payload,
      'the plaintext is not a JSON object',
    );
  }
  _checkJsonTypes(value);
  final wanted = kind == PayloadKind.event ? 'Event' : 'Calendar';
  if (value['@type'] != wanted) {
    throw CryptoException(
      CryptoError.payload,
      'the payload @type is not "$wanted"',
    );
  }
  final allowed = kind == PayloadKind.event
      ? eventPayloadMembers
      : calendarPayloadMembers;
  for (final name in value.keys) {
    if (name != '@type' && !allowed.contains(name)) {
      throw CryptoException(
        CryptoError.payload,
        'the member "$name" is not in the version-1 allow-list',
      );
    }
  }
  if (kind == PayloadKind.calendar && checkCalendarValues) {
    _checkCalendarValues(value);
  }
  return value;
}

/// §4.2's structural rules: no `null`, and integers only, at any depth.
void _checkJsonTypes(Object? value) {
  if (value is Map<String, Object?>) {
    for (final member in value.values) {
      if (member == null) {
        throw const CryptoException(
          CryptoError.payload,
          'a null member value is refused (§4.2)',
        );
      }
      _checkJsonTypes(member);
    }
  } else if (value is List) {
    for (final item in value) {
      if (item == null) {
        throw const CryptoException(
          CryptoError.payload,
          'a null member value is refused (§4.2)',
        );
      }
      _checkJsonTypes(item);
    }
  } else if (value is bool || value is String) {
    return;
  } else if (value is int) {
    if (value < -maxSafeInteger || value > maxSafeInteger) {
      throw const CryptoException(
        CryptoError.payload,
        'an integer outside the safe range is refused (§4.2)',
      );
    }
  } else {
    // A double: §4.2 allows integers only, for both members and array items.
    throw const CryptoException(
      CryptoError.payload,
      'numbers must be integers (§4.2)',
    );
  }
}

/// §4.3's value rules for a calendar-metadata payload.
void _checkCalendarValues(Map<String, Object?> payload) {
  final name = payload['name'];
  final colour = payload['color'];
  if (name is! String || name.isEmpty || utf8.encode(name).length > 255) {
    throw const CryptoException(
      CryptoError.payload,
      'the calendar name must be a string of 1 … 255 UTF-8 bytes (§4.3)',
    );
  }
  if (colour is! String || !_colour.hasMatch(colour)) {
    throw const CryptoException(
      CryptoError.payload,
      'the calendar colour must be RFC 7986 lowercase hex (§4.3)',
    );
  }
}

bool _sameBytes(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
