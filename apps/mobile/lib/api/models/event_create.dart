// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'event_alarm.dart';
import 'event_time.dart';

part 'event_create.g.dart';

/// A create request. `start` is required; the API mints the `DTSTAMP` and, on a Shared calendar, the `UID`. A `local` time is written with its `TZID` and a generated `VTIMEZONE` for that zone embedded in the object (E05-R09). On a Private calendar `uid`, `envelope`, `epoch` and `envelopeSha256` are required and the content fields (`summary`, `description`, `location`, `attendees`) are a 422: the object is a skeleton and the content lives in the sidecar envelope, which the one request commits in D-06 order (D-18, E03-R09, E13-R02). The client names the `UID` because the envelope's AAD binds it (D-14, E10-R06). Any other member is a 422 as well.
@JsonSerializable()
class EventCreate {
  const EventCreate({
    required this.start,
    this.uid,
    this.end,
    this.rrule,
    this.alarm,
    this.envelopeSha256,
    this.envelope,
    this.epoch,
    this.summary,
    this.description,
    this.location,
    this.attendees,
  });

  factory EventCreate.fromJson(Map<String, Object?> json) =>
      _$EventCreateFromJson(json);

  /// The `UID`: a lowercase UUIDv4 (INV-03). Required on a Private calendar, where the client seals the envelope over it (the AAD binds the `UID`, D-14) so the API cannot mint one; a calendar that is not Private mints it and does not take it.
  final String? uid;
  final EventTime start;
  final EventTime? end;

  /// The recurrence rule, in the RFC 5545 § 3.3.10 form: `FREQ` first, only the parts the RFC names and each at most once, `COUNT` or `UNTIL` but not both, `UNTIL` with the value type of the start — a UTC `DATE-TIME` for any timed start, a `TZID` one included, and a `DATE` for an all-day one — and neither `BYWEEKNO` nor a yearly rule on a 29 February start. Create only: a change to a recurring event is an intent (E05-R06/R07), never a rule a client writes.
  final String? rrule;
  final EventAlarm? alarm;

  /// The SHA-256 of the sealed content envelope, 64 lowercase hex digits. Required on a Private calendar, where the envelope and the skeleton are committed together (E03-R09, E13-R02); the API refuses bytes that do not hash to it.
  final String? envelopeSha256;

  /// The sealed envelope bytes in standard base64: version `0x01`, the big-endian uint32 epoch, the 24-byte nonce, ciphertext and tag. At least 45 bytes, at most 65,536 (`spec/crypto.md` §1.1). Required on a Private calendar and stored opaquely; the API never opens one (INV-07).
  final String? envelope;

  /// The CCK epoch the envelope header carries, 0 through 2147483647. Required on a Private calendar and part of the sidecar key.
  final int? epoch;

  /// The title. Refused with 422 on a Private calendar (D-18); Shared calendars take one from Phase 4.
  final String? summary;

  /// The description. Refused with 422 on a Private calendar (D-18).
  final String? description;

  /// The location. Refused with 422 on a Private calendar (D-18).
  final String? location;

  /// The attendee addresses. Refused with 422 on a Private calendar (D-18).
  final List<String>? attendees;

  Map<String, Object?> toJson() => _$EventCreateToJson(this);
}
