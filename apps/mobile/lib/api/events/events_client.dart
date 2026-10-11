// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/event.dart';
import '../models/event_create.dart';
import '../models/event_update.dart';

part 'events_client.g.dart';

@RestApi()
abstract class EventsClient {
  factory EventsClient(Dio dio, {String? baseUrl}) = _EventsClient;

  /// Create an event.
  ///
  /// The client sends fields, never iCalendar: the API mints the `UID` (`crypto.randomUUID()`, INV-03) and the `DTSTAMP`, builds the object with `ical.js` and writes it with `If-None-Match: *`, so two creates cannot overwrite each other and a client can never write `EXDATE` or `RECURRENCE-ID` (INV-05). The object name is `<uid>.ics`.
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
  /// `rrule`, `uid`, `exdate` and `recurrenceId` are refused with 422: an edit to a recurring event is an intent (E05-R06/R07), and a client never writes the recurrence itself (INV-05). A member that is `null` removes the property it names. Everything the change did not touch — an override, a `VTIMEZONE`, an `X-` property — comes back unchanged (INV-02). On a Private calendar the content fields are a 422 (D-18).
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
}
