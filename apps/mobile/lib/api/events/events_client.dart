// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/calendar_changes.dart';
import '../models/event.dart';
import '../models/event_create.dart';
import '../models/event_update.dart';

part 'events_client.g.dart';

@RestApi()
abstract class EventsClient {
  factory EventsClient(Dio dio, {String? baseUrl}) = _EventsClient;

  /// Create an event.
  ///
  /// The client sends fields, never iCalendar: the API mints the `UID` (`crypto.randomUUID()`, INV-03) and the `DTSTAMP`, builds the object with `ical.js` and writes it with `If-None-Match: *`, so two creates cannot overwrite each other and a client never writes the recurrence itself — an exception or an occurrence override is an intent (E05-R06/R07, INV-05). The object name is `<uid>.ics`.
  /// A time is a `date`, an `utc` instant or a `local` wall clock beside an IANA `tzid`: a `TZID` write is written as the wall clock it spells, with the `TZID` parameter and a generated `VTIMEZONE` for that zone embedded in the object, so an object always defines the zones it uses (E05-R09). A zone that is not an IANA name in its exact spelling — a Windows zone name, a wrong-case spelling, an unknown one — is a 422.
  /// The answer carries the raw iCalendar object (`ical`, byte for byte), the CalDAV `ETag` — also the `ETag` header — and a parsed convenience view of the master `VEVENT`. Until Phase 4 every calendar is Private (ADR 0003), so the object is a skeleton: `summary`, `description`, `location` and `attendees` are refused with 422 (they arrive with Shared calendars) and `envelopeSha256` is required, because a Private `VEVENT` carries exactly one `X-CALFLEX-ENVELOPE-SHA256` (E03-R09, D-18).
  /// The request body is validated by the route rather than by a schema: a schema-refused body is a 400, and every rule above must answer 422.
  ///
  /// [calendarId] - The `calendars.id` uuid of the calendar to write into.
  @POST('/calendars/{calendarId}/events')
  Future<Event> createEvent({
    @Path('calendarId') required String calendarId,
    @Body() required EventCreate body,
  });

  /// Read one event.
  ///
  /// Answers the object as the collection stores it — `ical` byte for byte, the CalDAV `ETag` (also the `ETag` header) and the parsed view of the master `VEVENT` — which is what a client caches as the canonical record (`docs/02` § Offline cache). An object with several `VEVENT`s (a master beside its overrides) is read whole; `parsed` describes the master and the `ical` carries the rest.
  ///
  /// [calendarId] - The `calendars.id` uuid of the calendar.
  ///
  /// [uid] - The event's `UID`, a lowercase UUIDv4, exactly as the create answered it. Any other shape names no object and is a 404.
  @GET('/calendars/{calendarId}/events/{uid}')
  Future<Event> readEvent({
    @Path('calendarId') required String calendarId,
    @Path('uid') required String uid,
  });

  /// Change an event.
  ///
  /// The client sends the fields it wants changed and the `If-Match` it read. The API reads the stored object, applies the change with `ical.js`, bumps `SEQUENCE` and `DTSTAMP`, and `PUT`s with the same `If-Match`, which CalDAV checks — so a write that lost a race is a 412 and never an overwrite. The 412 carries the current representation in the problem's `current` member, and nothing of the request that lost.
  /// `rrule` and `uid` are refused with 422, and so is any member naming a recurrence exception or an occurrence override: an edit to a recurring event is an intent (E05-R06/R07), and a client never writes the recurrence itself (INV-05). A member that is `null` removes the property it names, and a body that carries no member at all is a 422 as well. Everything the change did not touch — an override component, a `VTIMEZONE`, an `X-` property — comes back unchanged (INV-02). On a Private calendar the content fields are a 422 (D-18).
  /// A time field takes the same three forms a create takes, a `TZID` one included: the wall clock is written as it was sent, and a zone the object does not define yet is embedded beside it (E05-R09). An object whose stored `TZID` the IANA zone database cannot resolve keeps its own spelling until a patch replaces **both** `start` and `end` with values this API can write — a patch that touches only one of them is a 422 rather than a write that pairs a time it can read with one it cannot.
  ///
  /// [calendarId] - The `calendars.id` uuid of the calendar.
  ///
  /// [uid] - The event's `UID`, a lowercase UUIDv4.
  ///
  /// [ifMatch] - The object's `ETag`, as the read answered it. A list of validators and `*` are allowed; the store decides which of them matches.
  @PATCH('/calendars/{calendarId}/events/{uid}')
  Future<Event> updateEvent({
    @Path('calendarId') required String calendarId,
    @Path('uid') required String uid,
    @Header('If-Match') required String ifMatch,
    @Body() required EventUpdate body,
  });

  /// Delete an event.
  ///
  /// Removes the object from the collection, conditioned on the `If-Match` the client read: a `DELETE` with a stale validator is a 412 and the object stays. The answer is 204 with no body. A `uid` the collection does not hold is a 404, whatever the validator says — Sabre looks the object up before it checks a precondition.
  ///
  /// [calendarId] - The `calendars.id` uuid of the calendar.
  ///
  /// [uid] - The event's `UID`, a lowercase UUIDv4.
  ///
  /// [ifMatch] - The object's `ETag`, as the read answered it. A list of validators and `*` are allowed; the store decides which of them matches.
  @DELETE('/calendars/{calendarId}/events/{uid}')
  Future<void> deleteEvent({
    @Path('calendarId') required String calendarId,
    @Path('uid') required String uid,
    @Header('If-Match') required String ifMatch,
  });

  /// List what changed since a token.
  ///
  /// The incremental sync our own clients use. With no `since`, the whole collection is reported as present objects — the initial load; with one, only what changed since that token, a tombstone for each deletion.
  /// The answer is pointers, never content: a change is a `uid`, an `etag` and whether the object is gone. Fetch the object itself for its bytes. `etag` is absent on a tombstone, so a deletion can never be mistaken for a stale copy.
  /// `since` is an opaque token only this API mints: it names a point in one calendar's history and never leaves it. A value that is not one of ours, one minted for another calendar, and one that names a point the collection has never reached are all the same 410 — the client reloads fully, which is the only safe reading of a cursor that may have been skipped over. The response never echoes the token it refused.
  /// Roles are the reading roles: `owner`, `editor` and `viewer` all read, and a caller who is not a member gets the 404 an unknown id gets.
  ///
  /// [calendarId] - The `calendars.id` uuid of the calendar.
  ///
  /// [since] - The `token` a previous answer to this operation returned, verbatim. Absent means the initial load, which reports the whole collection.
  @GET('/calendars/{calendarId}/changes')
  Future<CalendarChanges> listCalendarChanges({
    @Path('calendarId') required String calendarId,
    @Query('since') String? since,
  });
}
