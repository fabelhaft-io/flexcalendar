// The generated client's time models → the domain's event time (E10-R04).
//
// The adapter is here, next to the domain type, so the rest of the app never
// reads a wire field directly: `lib/api/` is generated from the OpenAPI spec
// (E02-R07) and both of its time shapes — an event's and an occurrence's — carry
// the same four fields (from-E05-R09).

import '../../../api/models/event_time.dart' as api;
import '../../../api/models/occurrence_time.dart' as api;
import 'event_time.dart';

/// An event's `start` or `end` (E05-R09 / E05-R03).
extension ApiEventTimeAdapter on api.EventTime {
  EventTime toDomain() =>
      eventTimeFromApi(date: date, utc: utc, tzid: tzid, local: local);
}

/// One occurrence of a window query (E05-R05 / E05-R03). A `local`/`tzid`
/// occurrence carries the zone the request asked for, and always the `utc`
/// instant beside it.
extension ApiOccurrenceTimeAdapter on api.OccurrenceTime {
  EventTime toDomain() =>
      eventTimeFromApi(date: date, utc: utc, tzid: tzid, local: local);
}
