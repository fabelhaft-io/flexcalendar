/// The canonical timing fields of `spec/crypto.md` §3, and the canonical
/// `recurrence_id` of §5.2.
///
/// Fields 5–7 of the event AAD are computed from the **parsed** iCalendar values,
/// never from the property text as it happens to be spelled in the stored object:
/// a re-serialised skeleton (the API rewrites one on every `ical.js` round trip)
/// may change spelling — part order, an explicit default, a `+` sign — without
/// changing the meaning, and a spelling-insensitive AAD is the only one that
/// survives it.
///
/// The AAD binds a zoned time as its `TZID` and its **wall clock**, never an
/// instant a zone database computes (§3.5): a tzdata update must not make stored
/// envelopes unreadable. A zone database is still needed for §3.4's answers — the
/// canonical `recurrence_id` of a zoned recurrence id is converted to UTC — so
/// those conversions go through the `timezone` package (ADR 0002).
library;

import 'package:timezone/data/latest_all.dart' as timezone_data;
import 'package:timezone/timezone.dart' as timezone;

import 'errors.dart';

/// The weekdays, with Monday first (§3.3's `BYDAY` sort key).
const List<String> weekdays = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/// The rule parts, in RFC 5545 §3.3.10's order — which also fixes `UNTIL` before
/// `COUNT`.
const List<String> rrulePartOrder = [
  'FREQ',
  'UNTIL',
  'COUNT',
  'INTERVAL',
  'BYSECOND',
  'BYMINUTE',
  'BYHOUR',
  'BYDAY',
  'BYMONTHDAY',
  'BYYEARDAY',
  'BYWEEKNO',
  'BYMONTH',
  'BYSETPOS',
  'WKST',
];

/// `name` → (`low`, `high`, `signed`) for the numeric rule parts, per
/// RFC 5545 §3.3.10's ranges. A signed part allows a negative value of the same
/// magnitude.
const Map<String, List<Object>> rruleRanges = {
  'BYSECOND': [0, 60, false],
  'BYMINUTE': [0, 59, false],
  'BYHOUR': [0, 23, false],
  'BYMONTHDAY': [1, 31, true],
  'BYYEARDAY': [1, 366, true],
  'BYWEEKNO': [1, 53, true],
  'BYMONTH': [1, 12, false],
  'BYSETPOS': [1, 366, true],
};

/// One iCalendar content line, split the way RFC 5545 §3.1 defines it.
class IcalProperty {
  const IcalProperty(this.name, this.params, this.value);

  /// The property name, uppercased.
  final String name;

  /// Parameter name (uppercased) → raw value.
  final Map<String, String> params;

  /// The value, still escaped and unfolded as it was stored.
  final String value;

  /// Parses `NAME;PARAM=VALUE:value`, refusing anything malformed with
  /// `E_SKELETON`.
  ///
  /// The line is split at its **first** colon: a parameter value may not contain
  /// one, but a property value may (a URL, a `TZID`).
  factory IcalProperty.parse(String line) {
    final colon = line.indexOf(':');
    if (colon < 0) {
      throw const CryptoException(
        CryptoError.skeleton,
        'a content line has no ":"',
      );
    }
    final head = line.substring(0, colon);
    final value = line.substring(colon + 1);
    final pieces = head.split(';');
    final name = pieces.first.toUpperCase();
    if (name.isEmpty) {
      throw const CryptoException(
        CryptoError.skeleton,
        'an empty property name',
      );
    }
    final params = <String, String>{};
    for (final piece in pieces.skip(1)) {
      final equals = piece.indexOf('=');
      if (equals <= 0) {
        throw const CryptoException(
          CryptoError.skeleton,
          'a parameter has no name or no "="',
        );
      }
      final key = piece.substring(0, equals).toUpperCase();
      if (params.containsKey(key)) {
        throw CryptoException(
          CryptoError.skeleton,
          'the parameter $key appears twice',
        );
      }
      params[key] = piece.substring(equals + 1);
    }
    return IcalProperty(name, params, value);
  }

  @override
  String toString() => '$name($params):$value';
}

/// The canonical §3 timing fields of one skeleton, plus its `UID`.
class CanonicalTiming {
  const CanonicalTiming({
    required this.uid,
    required this.dtstart,
    required this.end,
    required this.rrule,
    required this.recurrenceId,
  });

  /// The `UID` value as parsed: unfolded and unescaped (AAD field 2).
  final String uid;

  /// AAD field 5: `date:…`, `utc:…` or `zoned:TZID@…`.
  final String dtstart;

  /// AAD field 6: the same three forms, `dur:…`, or the literal `none`.
  final String end;

  /// AAD field 7: `rrule:…` or the literal `none`.
  final String rrule;

  /// §5.2's canonical `recurrence_id`: empty for the master, `YYYYMMDD` for an
  /// all-day occurrence, or a UTC instant.
  final String recurrenceId;

  /// §3's fields of the skeleton in [properties] (a list of iCalendar content
  /// lines), and §5.2's canonical `recurrence_id` of [recurrenceId].
  ///
  /// [recurrenceId] is the structured value the API reports for the occurrence —
  /// `GET …/occurrences` and the parsed event view carry it — never a content
  /// line: a client addresses an occurrence with the id the server gave it and
  /// never writes one itself (INV-05). It is absent for the master.
  factory CanonicalTiming.fromProperties(
    List<String> properties, {
    RecurrenceId? recurrenceId,
  }) {
    final lines = <String, String>{};
    for (final line in properties) {
      final parsed = IcalProperty.parse(line);
      if (lines.containsKey(parsed.name)) {
        throw CryptoException(
          CryptoError.skeleton,
          'the skeleton carries ${parsed.name} twice',
        );
      }
      lines[parsed.name] = line;
    }
    if (!lines.containsKey('DTSTART')) {
      throw const CryptoException(
        CryptoError.skeleton,
        'a VEVENT without DTSTART has no AAD',
      );
    }
    if (!lines.containsKey('UID')) {
      throw const CryptoException(
        CryptoError.skeleton,
        'a VEVENT without UID has no AAD',
      );
    }
    final uid = IcalProperty.parse(lines['UID']!).value;
    final start = IcalProperty.parse(lines['DTSTART']!);

    String end;
    if (lines.containsKey('DTEND') && lines.containsKey('DURATION')) {
      throw const CryptoException(
        CryptoError.skeleton,
        'RFC 5545 §3.6.1 forbids DTEND and DURATION together',
      );
    }
    if (lines.containsKey('DTEND')) {
      final parsed = IcalProperty.parse(lines['DTEND']!);
      end = canonicalTimeField(parsed.params, parsed.value);
    } else if (lines.containsKey('DURATION')) {
      final parsed = IcalProperty.parse(lines['DURATION']!);
      end = 'dur:${canonicalDuration(parsed.value)}';
    } else {
      end = 'none';
    }

    final rrule = lines.containsKey('RRULE')
        ? 'rrule:${canonicalRrule(IcalProperty.parse(lines['RRULE']!).value)}'
        : 'none';

    return CanonicalTiming(
      uid: uid,
      dtstart: canonicalTimeField(start.params, start.value),
      end: end,
      rrule: rrule,
      recurrenceId: canonicalRecurrenceId(recurrenceId),
    );
  }
}

/// AAD field 5/6 of one `DTSTART`/`DTEND`-shaped property (§3.1, §3.2).
///
/// A `DATE-TIME` with neither `Z` nor `TZID` is floating and refused with
/// `E_UNSUPPORTED` (INV-04); a recurrence id that carries no zone is refused too,
/// by [canonicalRecurrenceId] (§5.2).
String canonicalTimeField(Map<String, String> params, String value) {
  if ((params['VALUE'] ?? '').toUpperCase() == 'DATE') {
    return 'date:${_checkDate(value)}';
  }
  if (params.containsKey('TZID')) {
    if (value.endsWith('Z')) {
      throw const CryptoException(
        CryptoError.skeleton,
        'a TZID value may not also carry Z',
      );
    }
    final tzid = params['TZID']!;
    if (tzid.isEmpty || tzid.contains('@') || tzid.contains(':')) {
      throw const CryptoException(
        CryptoError.skeleton,
        'a malformed TZID parameter',
      );
    }
    // The TZID is written exactly as parsed: `Asia/Calcutta` and `Asia/Kolkata`
    // are different field values, and normalising one into the other would move
    // the AAD (§3.1).
    return 'zoned:$tzid@${_checkLocal(value)}';
  }
  if (value.endsWith('Z')) {
    return 'utc:${_checkInstant(value)}';
  }
  throw const CryptoException(
    CryptoError.unsupported,
    'a floating DATE-TIME has no AAD field',
  );
}

/// §3.2.1's duration: components exactly as parsed, no carrying, no leading `+`,
/// `PT0S` for zero.
String canonicalDuration(String text) {
  var value = text;
  var sign = '';
  if (value.startsWith('+')) {
    value = value.substring(1);
  } else if (value.startsWith('-')) {
    sign = '-';
    value = value.substring(1);
  }
  if (!value.startsWith('P')) {
    throw const CryptoException(
      CryptoError.skeleton,
      'a duration must start with P',
    );
  }
  final body = value.substring(1);
  if (body.isEmpty) {
    throw const CryptoException(
      CryptoError.skeleton,
      'P alone is not a duration',
    );
  }
  var weeks = 0;
  var days = 0;
  var hours = 0;
  var minutes = 0;
  var seconds = 0;
  if (body.endsWith('W')) {
    final digits = body.substring(0, body.length - 1);
    if (!_isDigits(digits)) {
      throw const CryptoException(
        CryptoError.skeleton,
        'P1W2D is not a duration',
      );
    }
    weeks = int.parse(digits);
  } else {
    final t = body.indexOf('T');
    final datePart = t < 0 ? body : body.substring(0, t);
    final timePart = t < 0 ? '' : body.substring(t + 1);
    if (datePart.isNotEmpty) {
      if (!datePart.endsWith('D')) {
        throw const CryptoException(
          CryptoError.skeleton,
          'a day component must end in D',
        );
      }
      final digits = datePart.substring(0, datePart.length - 1);
      if (!_isDigits(digits)) {
        throw const CryptoException(
          CryptoError.skeleton,
          'a day component needs a leading digit',
        );
      }
      days = int.parse(digits);
    } else if (t < 0) {
      throw const CryptoException(
        CryptoError.skeleton,
        'a duration with no component',
      );
    }
    if (t >= 0) {
      final match = RegExp(r'^(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$')
          .firstMatch(timePart);
      if (match == null ||
          (match.group(1) == null &&
              match.group(2) == null &&
              match.group(3) == null)) {
        throw const CryptoException(
          CryptoError.skeleton,
          'a time component must be H, M or S',
        );
      }
      hours = int.parse(match.group(1) ?? '0');
      minutes = int.parse(match.group(2) ?? '0');
      seconds = int.parse(match.group(3) ?? '0');
    }
  }
  if (weeks != 0) {
    return '${sign}P${weeks}W';
  }
  if (days == 0 && hours == 0 && minutes == 0 && seconds == 0) {
    return 'PT0S';
  }
  final out = StringBuffer(sign)..write('P');
  if (days != 0) out.write('${days}D');
  if (hours != 0 || minutes != 0 || seconds != 0) {
    out.write('T');
    if (hours != 0) out.write('${hours}H');
    if (minutes != 0) out.write('${minutes}M');
    if (seconds != 0) out.write('${seconds}S');
  }
  return out.toString();
}

/// §3.3's `RRULE`: parts in the ABNF order, uppercase, `;`-separated, each at
/// most once, with the RFC's defaults dropped.
String canonicalRrule(String text) {
  final parts = <String, String>{};
  for (final chunk in text.split(';')) {
    final equals = chunk.indexOf('=');
    final name = (equals < 0 ? chunk : chunk.substring(0, equals))
        .toUpperCase();
    final value = equals < 0 ? '' : chunk.substring(equals + 1);
    if (equals < 0 || value.isEmpty) {
      throw const CryptoException(
        CryptoError.skeleton,
        'a rule part with no value',
      );
    }
    if (!rrulePartOrder.contains(name)) {
      // The owner's ruling of 2026-10-12 forbids an X- rule part.
      throw CryptoException(
        CryptoError.unsupported,
        'the rule part $name is not in version 1',
      );
    }
    if (parts.containsKey(name)) {
      // A last-one-wins parser would be a malleability hole: two spellings would
      // produce one AAD only by accident.
      throw CryptoException(
        CryptoError.skeleton,
        'the rule part $name appears twice',
      );
    }
    parts[name] = value;
  }
  if (!parts.containsKey('FREQ')) {
    throw const CryptoException(CryptoError.skeleton, 'an RRULE needs FREQ');
  }
  if (parts.containsKey('UNTIL') && parts.containsKey('COUNT')) {
    throw const CryptoException(
      CryptoError.skeleton,
      'UNTIL and COUNT are mutually exclusive',
    );
  }
  final out = <String>[];
  for (final name in rrulePartOrder) {
    if (!parts.containsKey(name)) continue;
    final value = parts[name]!;
    if (name == 'FREQ') {
      final freq = value.toUpperCase();
      if (!const {
        'SECONDLY',
        'MINUTELY',
        'HOURLY',
        'DAILY',
        'WEEKLY',
        'MONTHLY',
        'YEARLY',
      }.contains(freq)) {
        throw const CryptoException(CryptoError.skeleton, 'an unknown FREQ');
      }
      out.add('FREQ=$freq');
    } else if (name == 'UNTIL') {
      if (RegExp(r'^\d{8}$').hasMatch(value)) {
        out.add('UNTIL=${_checkDate(value)}');
      } else {
        out.add('UNTIL=${_checkInstant(value.toUpperCase())}');
      }
    } else if (name == 'COUNT' || name == 'INTERVAL') {
      if (!_isDigits(value)) {
        throw CryptoException(CryptoError.skeleton, '$name is not a decimal');
      }
      final number = int.parse(value);
      if (number < 1) {
        throw CryptoException(CryptoError.skeleton, '$name is below 1');
      }
      if (name == 'INTERVAL' && number == 1) continue; // the RFC's default
      out.add('$name=$number');
    } else if (name == 'BYDAY') {
      final entries = <List<int>>{};
      for (final entry in value.split(',')) {
        final match = RegExp(r'^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$')
            .firstMatch(entry.toUpperCase());
        if (match == null) {
          throw const CryptoException(
            CryptoError.skeleton,
            'a malformed BYDAY entry',
          );
        }
        final weekday = weekdays.indexOf(match.group(2)!);
        final ordinalText = match.group(1);
        final ordinal = ordinalText == null ? 0 : int.parse(ordinalText);
        if (ordinal != 0 && ordinal.abs() > 53) {
          throw const CryptoException(
            CryptoError.skeleton,
            'a BYDAY ordinal is out of range',
          );
        }
        entries.add([weekday, ordinal]);
      }
      final ordered = entries.toList()
        ..sort((a, b) {
          if (a[0] != b[0]) return a[0].compareTo(b[0]);
          return a[1].compareTo(b[1]);
        });
      out.add(
        'BYDAY=${ordered.map((entry) => '${entry[1] == 0 ? '' : entry[1]}${weekdays[entry[0]]}').join(',')}',
      );
    } else if (name == 'WKST') {
      final day = value.toUpperCase();
      if (!weekdays.contains(day)) {
        throw const CryptoException(CryptoError.skeleton, 'an unknown WKST');
      }
      if (day != 'MO') out.add('WKST=$day'); // the RFC's default
    } else {
      final range = rruleRanges[name]!;
      final low = range[0] as int;
      final high = range[1] as int;
      final signed = range[2] as bool;
      final numbers = <int>{};
      for (final entry in value.split(',')) {
        if (!RegExp(r'^[+-]?\d+$').hasMatch(entry)) {
          throw CryptoException(
            CryptoError.skeleton,
            'a $name value is not a decimal',
          );
        }
        final number = int.parse(entry);
        final inRange = signed
            ? number.abs() >= low && number.abs() <= high
            : number >= low && number <= high;
        if (!inRange) {
          throw CryptoException(
            CryptoError.skeleton,
            'a $name value is out of range',
          );
        }
        numbers.add(number);
      }
      final ordered = numbers.toList()..sort();
      out.add('$name=${ordered.join(',')}');
    }
  }
  return out.join(';');
}

/// One occurrence's recurrence id, in the shape the API reports it to a client.
///
/// `GET …/occurrences` and the parsed event view carry exactly these forms for an
/// occurrence an override replaces, and nothing at all for a master: an all-day
/// date, an instant, or a wall clock beside the zone it is written in. It is what
/// an edit intent sends back to address one occurrence — a client never writes
/// the stored property itself (INV-05, §5.2).
class RecurrenceId {
  /// An all-day occurrence: `YYYY-MM-DD`, the spelling the API reports.
  const RecurrenceId.date(this.value) : tzid = null, _form = _Form.date;

  /// An instant: `YYYYMMDDTHHMMSSZ`.
  const RecurrenceId.utc(this.value) : tzid = null, _form = _Form.utc;

  /// A wall clock (`YYYYMMDDTHHMMSS`) beside the zone it is written in.
  ///
  /// Without a [tzid] this is the floating form §5.2 refuses, and
  /// [canonicalRecurrenceId] raises `E_SKELETON` for it rather than reading the
  /// clock as UTC.
  const RecurrenceId.local(this.value, {this.tzid}) : _form = _Form.local;

  /// The API's `recurrenceId` object, as its own clients parse it.
  ///
  /// The map may carry more than one field: the API reports a zoned occurrence as
  /// `local`, `tzid` **and** the instant that reading names. The wall clock and its
  /// zone decide, because §5.2's canonical value is computed from them with §3.4's
  /// answers, not from an instant some other library computed for them.
  factory RecurrenceId.fromJson(Map<String, Object?> json) {
    final local = json['local'];
    final tzid = json['tzid'];
    if (local is String && tzid is String) {
      return RecurrenceId.local(local, tzid: tzid);
    }
    final utc = json['utc'];
    if (utc is String) return RecurrenceId.utc(utc);
    if (local is String) return RecurrenceId.local(local);
    final date = json['date'];
    if (date is String) return RecurrenceId.date(date);
    throw const CryptoException(
      CryptoError.skeleton,
      'a recurrence id with no date, instant or wall clock',
    );
  }

  /// The date, instant or wall clock, spelled as the API spells it.
  final String value;

  /// The zone a [RecurrenceId.local] reading is written in, when the API names
  /// one.
  final String? tzid;

  final _Form _form;
}

enum _Form { date, utc, local }

/// §5.2's canonical `recurrence_id`: `''` for the master, `YYYYMMDD` for an
/// all-day occurrence, a UTC instant otherwise.
///
/// A wall clock beside its zone is converted with §3.4's answers — the offset in
/// force *before* a gap or an overlap — so one occurrence has one value and one
/// sidecar key whichever way the stored object spells it. A reading with no zone,
/// or with a zone the database does not know, is `E_SKELETON`: §5.2 refuses to
/// read a local clock as UTC.
String canonicalRecurrenceId(RecurrenceId? recurrenceId) {
  if (recurrenceId == null) return '';
  switch (recurrenceId._form) {
    case _Form.date:
      return _checkDate(_compactDate(recurrenceId.value));
    case _Form.utc:
      return _checkInstant(recurrenceId.value);
    case _Form.local:
      final tzid = recurrenceId.tzid;
      if (tzid == null) {
        throw const CryptoException(
          CryptoError.skeleton,
          'a recurrence id that carries no zone has no canonical value',
        );
      }
      return instantOfZoned(tzid, recurrenceId.value);
  }
}

/// `YYYY-MM-DD`, the spelling the API reports a date in, as §5.2's `YYYYMMDD`.
///
/// The shape is checked here; [_checkDate] then refuses a date that is not a date.
String _compactDate(String value) {
  final pieces = value.split('-');
  if (pieces.length != 3 ||
      pieces[0].length != 4 ||
      pieces[1].length != 2 ||
      pieces[2].length != 2) {
    throw const CryptoException(
      CryptoError.skeleton,
      'a date must be YYYY-MM-DD',
    );
  }
  return '${pieces[0]}${pieces[1]}${pieces[2]}';
}

/// The UTC instant of a canonical §3 timing field, or `null` for a `date:` one.
///
/// §3.4 pins RFC 5545's answer for the two ambiguous cases, so this is not simply
/// `timezone`'s conversion (which follows Java and Joda and picks the *other*
/// offset in both):
///
/// * a local time that does not exist (a spring-forward gap) is read with the UTC
///   offset **before** the gap, and
/// * a local time that occurs twice (an autumn overlap) refers to the **first**
///   occurrence, i.e. the pre-transition offset.
String? instantOf(String field) {
  if (field.startsWith('date:')) return null;
  if (field.startsWith('utc:')) return field.substring('utc:'.length);
  final rest = field.substring('zoned:'.length);
  final at = rest.indexOf('@');
  if (at < 0) {
    throw const CryptoException(
      CryptoError.skeleton,
      'a malformed zoned field',
    );
  }
  return instantOfZoned(rest.substring(0, at), rest.substring(at + 1));
}

/// §3.4's answer for `TZID` + wall clock: `YYYYMMDDTHHMMSSZ`.
///
/// A zone name the database does not know is `E_SKELETON` — §5.2 refuses a
/// recurrence id with no resolvable zone rather than reading a local clock as
/// UTC.
String instantOfZoned(String tzid, String local) {
  final wall = _wallClock(local);
  final location = _location(tzid);
  int? offsetAt(DateTime utc) =>
      location.timeZone(utc.millisecondsSinceEpoch).offset.inMilliseconds;
  // The offsets in force around the wall clock: within a day of it there is at
  // most one transition, so these probes are the whole candidate set.
  final probes = <int>{
    offsetAt(wall.subtract(const Duration(hours: 26)))!,
    offsetAt(wall)!,
    offsetAt(wall.add(const Duration(hours: 26)))!,
  };
  final candidates = probes
      .map((offset) => wall.subtract(Duration(milliseconds: offset)))
      .toSet();
  final DateTime instant;
  if (candidates.length == 1) {
    instant = candidates.first;
  } else {
    // A gap or an overlap: §3.4 wants the offset in force *before* the
    // transition, which is the one around the earlier candidate.
    final earliest = candidates.reduce((a, b) => a.isBefore(b) ? a : b);
    final before = offsetAt(earliest.subtract(const Duration(seconds: 1)))!;
    instant = wall.subtract(Duration(milliseconds: before));
  }
  final text =
      '${instant.year.toString().padLeft(4, '0')}'
      '${instant.month.toString().padLeft(2, '0')}'
      '${instant.day.toString().padLeft(2, '0')}'
      'T${instant.hour.toString().padLeft(2, '0')}'
      '${instant.minute.toString().padLeft(2, '0')}'
      '${instant.second.toString().padLeft(2, '0')}Z';
  return text;
}

DateTime _wallClock(String local) {
  if (!RegExp(r'^\d{8}T\d{6}$').hasMatch(local)) {
    throw const CryptoException(CryptoError.skeleton, 'a malformed local time');
  }
  final year = int.parse(local.substring(0, 4));
  final month = int.parse(local.substring(4, 6));
  final day = int.parse(local.substring(6, 8));
  final hour = int.parse(local.substring(9, 11));
  final minute = int.parse(local.substring(11, 13));
  final second = int.parse(local.substring(13, 15));
  if (!_isRealDate(year, month, day) ||
      hour > 23 ||
      minute > 59 ||
      second > 59) {
    throw const CryptoException(
      CryptoError.skeleton,
      'a local time that is not a time',
    );
  }
  return DateTime.utc(year, month, day, hour, minute, second);
}

bool _timeZonesReady = false;

/// The `timezone` package's location for [tzid].
///
/// `latest_all` rather than `latest`: the AAD binds the `TZID` *exactly as the
/// skeleton spelled it* (§3.1), so `Asia/Calcutta` — a name the tz database keeps
/// as a link — has to resolve as itself, and `latest` carries only the primary
/// names.
timezone.Location _location(String tzid) {
  if (!_timeZonesReady) {
    timezone_data.initializeTimeZones();
    _timeZonesReady = true;
  }
  try {
    return timezone.getLocation(tzid);
  } on timezone.LocationNotFoundException {
    throw CryptoException(
      CryptoError.skeleton,
      'the TZID "$tzid" is not in the time zone database',
    );
  }
}

String _checkDate(String value) {
  if (!RegExp(r'^\d{8}$').hasMatch(value)) {
    throw const CryptoException(
      CryptoError.skeleton,
      'a date must be YYYYMMDD',
    );
  }
  final year = int.parse(value.substring(0, 4));
  final month = int.parse(value.substring(4, 6));
  final day = int.parse(value.substring(6, 8));
  if (!_isRealDate(year, month, day)) {
    throw const CryptoException(
      CryptoError.skeleton,
      'a date that is not a date',
    );
  }
  return value;
}

String _checkLocal(String value) {
  if (!RegExp(r'^\d{8}T\d{6}$').hasMatch(value)) {
    throw const CryptoException(
      CryptoError.skeleton,
      'a DATE-TIME must be YYYYMMDDTHHMMSS',
    );
  }
  if (value.substring(13, 15) == '60') {
    // The AAD has no representation for a leap second (§3.1).
    throw const CryptoException(
      CryptoError.unsupported,
      'a leap second has no field',
    );
  }
  _wallClock(value);
  return value;
}

String _checkInstant(String value) {
  if (!value.endsWith('Z')) {
    throw const CryptoException(
      CryptoError.skeleton,
      'an instant must end in Z',
    );
  }
  return '${_checkLocal(value.substring(0, value.length - 1))}Z';
}

bool _isRealDate(int year, int month, int day) {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  final date = DateTime.utc(year, month, day);
  return date.year == year && date.month == month && date.day == day;
}

bool _isDigits(String value) {
  if (value.isEmpty) return false;
  for (var i = 0; i < value.length; i++) {
    final unit = value.codeUnitAt(i);
    if (unit < 0x30 || unit > 0x39) return false;
  }
  return true;
}
