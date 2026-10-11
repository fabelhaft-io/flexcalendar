// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:dio/dio.dart';
import 'package:retrofit/retrofit.dart';

import '../models/calendar.dart';
import '../models/calendar_create.dart';
import '../models/calendar_list.dart';
import '../models/calendar_meta.dart';

part 'calendars_client.g.dart';

@RestApi()
abstract class CalendarsClient {
  factory CalendarsClient(Dio dio, {String? baseUrl}) = _CalendarsClient;

  /// The caller's calendars.
  ///
  /// Every calendar the caller is a member of, oldest first. A calendar the caller cannot see is not listed, and a Private calendar's name and colour are inside `metaEnvelope` — the API never opens one (D-18).
  @GET('/calendars')
  Future<CalendarList> listCalendars();

  /// Create a calendar.
  ///
  /// Requires an explicit `mode`; there is no default (ADR 0001). Until Phase 4 only `private` is accepted (ADR 0003), and a Private calendar is created with `metaEnvelope` and `metaEpoch` instead of a plaintext `name` or `color` (D-18). The API checks the envelope's header (version `0x01`, the CCK epoch that `metaEpoch` names, at least the 45 bytes of fixed fields) and its size (at most 4096 bytes), stores it opaquely, and gives the CalDAV collection the fixed display name `Private calendar` (E03-R09). The `calendars` row and the owner's `calendar_members` row are committed before the collection is made, and removed again if that fails. Every rule of this list is a 422, never a 400.
  /// The request body is validated by the route rather than by a schema: a schema-refused body is a 400, and the rules above must answer 422.
  @POST('/calendars')
  Future<Calendar> createCalendar({@Body() required CalendarCreate body});

  /// Rename or recolour a calendar.
  ///
  /// A rename and a recolour are one act: both replace the sealed `metaEnvelope` and the `metaEpoch` it names. The request must carry `If-Match` with the version it read; a version that has moved on is a 412, a missing `If-Match` a 428, and the CalDAV collection keeps the fixed display name `Private calendar` whatever the envelope holds (D-18). Only the owner may do it; a member who is not the owner gets a 403, and a caller who is not a member a 404, exactly like an id that exists nowhere.
  ///
  /// [id] - The `calendars.id` uuid.
  ///
  /// [ifMatch] - The version the client read, quoted; `*` accepts any version.
  @PATCH('/calendars/{id}')
  Future<Calendar> replaceCalendarMetadata({
    @Path('id') required String id,
    @Header('If-Match') required String ifMatch,
    @Body() required CalendarMeta body,
  });

  /// Delete a calendar.
  ///
  /// Removes the CalDAV collection and every row the calendar owns; the membership row cascades from the `calendars` row. Only the owner may do it; a member who is not the owner gets a 403, and a caller who is not a member a 404, exactly like an id that exists nowhere. A collection that is already gone is not an error: the request wanted it gone.
  ///
  /// [id] - The `calendars.id` uuid.
  @DELETE('/calendars/{id}')
  Future<void> deleteCalendar({@Path('id') required String id});
}
