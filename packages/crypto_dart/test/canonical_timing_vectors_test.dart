/// `spec/crypto-vectors/canonical-timing-v1.json` — the canonical timing fields
/// of `spec/crypto.md` §3 and the canonical `recurrence_id` of §5.2.
///
/// The AAD binds a zoned time as its `TZID` and its wall clock, so a tzdata
/// update cannot make stored envelopes unreadable. `instants` in `expected` is
/// §3.4's cross-check of the RFC 5545 answer for the same value: it is asserted
/// here too, through the same code that converts a zoned `RECURRENCE-ID`.
library;

import 'package:crypto_dart/crypto_dart.dart';
import 'package:test/test.dart';

import 'vectors.dart';

void main() {
  final vectors = loadVectors('canonical-timing-v1.json');
  reportVectors('canonical-timing-v1.json', vectors);

  group('canonical-timing-v1.json', () {
    test('the file is non-empty and every vector is a timing vector', () {
      expect(vectors, isNotEmpty);
      expect(vectors.map((vector) => vector.op).toSet(), {'canonical_timing'});
    });

    for (final vector in vectors) {
      test('${vector.id} — ${vector.purpose}', () {
        final properties = (vector.inputs['skeleton_properties'] as List)
            .cast<String>();
        if (vector.isNegative) {
          expectRefusal(
            vector.pinnedError,
            () => CanonicalTiming.fromProperties(properties),
            '${vector.id} canonical_timing',
          );
          return;
        }
        final timing = CanonicalTiming.fromProperties(properties);
        final expected = vector.expected;
        expect(timing.dtstart, expected['dtstart'], reason: 'AAD field 5');
        expect(timing.end, expected['end'], reason: 'AAD field 6');
        expect(timing.rrule, expected['rrule'], reason: 'AAD field 7');
        expect(timing.recurrenceId, expected['recurrence_id'], reason: '§5.2');
        _expectInstants(vector, timing);
      });
    }
  });
}

/// §3.4's answer for every instant the vector pins.
void _expectInstants(Vector vector, CanonicalTiming timing) {
  final instants = vector.expected['instants'];
  if (instants is! List) return;
  expect(instants, isNotEmpty, reason: 'an empty instant list proves nothing');
  if (instants.length == 1) {
    expect(instantOf(timing.dtstart), instants.first);
    return;
  }
  // The one vector with more than one instant is a nominal DAILY rule
  // (`RRULE:FREQ=DAILY;COUNT=5` over a DST transition). Its occurrences are the
  // wall clock plus `n` days, each read with §3.4's offset — the same loop
  // `gen/generate.py`'s `expand_daily_skipped` runs. A general recurrence
  // expander is E15-R02's, not this package's.
  expect(timing.rrule, startsWith('rrule:FREQ=DAILY;COUNT='));
  final count = int.parse(timing.rrule.split('COUNT=').last);
  final start = timing.dtstart;
  expect(count, instants.length);
  final tzid = start.substring('zoned:'.length, start.indexOf('@'));
  final wall = start.split('@').last;
  final year = int.parse(wall.substring(0, 4));
  final month = int.parse(wall.substring(4, 6));
  final day = int.parse(wall.substring(6, 8));
  final clock = wall.substring(9);
  for (var offset = 0; offset < count; offset++) {
    final date = DateTime.utc(year, month, day).add(Duration(days: offset));
    final local =
        '${date.year.toString().padLeft(4, '0')}'
        '${date.month.toString().padLeft(2, '0')}'
        '${date.day.toString().padLeft(2, '0')}T$clock';
    expect(
      instantOfZoned(tzid, local),
      instants[offset],
      reason: 'occurrence ${offset + 1} of a nominal daily rule',
    );
  }
}
