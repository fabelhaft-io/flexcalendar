<?php

declare(strict_types=1);

namespace Calflex\Tests;

final class GuardCases
{
    /** The lowercase UUIDv4 every E03-R09/E03-R11 case is built around. */
    public const UID = 'adf46a78-3c92-4c1e-ab04-7f791296e61e';

    /** The object name a create of {@see self::UID} must use (E03-R11). */
    public static function uri(string $uid = self::UID): string
    {
        return $uid . '.ics';
    }

    public static function skeleton(string $uid = self::UID): string
    {
        return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Calflex//EN\r\nBEGIN:VEVENT\r\nUID:" . $uid . "\r\nDTSTAMP:20261009T080000Z\r\nDTSTART:20261012T100000Z\r\nDTEND:20261012T110000Z\r\nX-CALFLEX-ENVELOPE-SHA256:" . str_repeat('a', 64) . "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    }

    public static function eventLine(string $line, string $uid = self::UID): string
    {
        return str_replace('END:VEVENT', $line . "\r\nEND:VEVENT", self::skeleton($uid));
    }

    /** A `VEVENT` the way SabreDAV's repair leaves a body that had no `UID`. */
    public static function repairedSkeleton(): string
    {
        return self::skeleton('sabre-vobject-8667bd39-4545-4f77-b37b-06e3f1a8be28');
    }

    /** A `VALARM` with the given `UID` line, or none when `$uid` is null. */
    public static function alarm(?string $uid): string
    {
        return self::eventLine("BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\n" . ($uid === null ? '' : "UID:$uid\r\n") . "DESCRIPTION:Reminder\r\nEND:VALARM");
    }

    /** A second `VEVENT` sharing the object with a different `UID`. */
    public static function secondEvent(string $uid): string
    {
        return str_replace('END:VCALENDAR', "BEGIN:VEVENT\r\nUID:$uid\r\nDTSTAMP:20261009T080000Z\r\nDTSTART:20261013T100000Z\r\nDTEND:20261013T110000Z\r\nX-CALFLEX-ENVELOPE-SHA256:" . str_repeat('a', 64) . "\r\nEND:VEVENT\r\nEND:VCALENDAR", self::skeleton());
    }

    /**
     * E03-R11 — creates in a Private calendar that are refused, table beside the
     * E03-R09 one. Row: the object name the `PUT` addresses, the body, and the
     * name the `cf:private-skeleton-only` precondition must carry.
     *
     * @return array<string, array{uri: string, text: string, name: string}>
     */
    public static function objectCreatesRejected(): array
    {
        return [
            'uid_missing' => ['uri' => self::uri(), 'text' => str_replace('UID:' . self::UID . "\r\n", '', self::skeleton()), 'name' => 'UID'],
            'uid_repaired' => ['uri' => self::uri(), 'text' => self::repairedSkeleton(), 'name' => 'UID'],
            'uid_uppercase' => ['uri' => self::uri(), 'text' => self::skeleton(strtoupper(self::UID)), 'name' => 'UID'],
            'uid_marker' => ['uri' => self::uri(), 'text' => self::skeleton('CALFLEX_GUARD_MARKER_uid'), 'name' => 'UID'],
            'uid_version' => ['uri' => self::uri(), 'text' => self::skeleton('adf46a78-3c92-3c1e-ab04-7f791296e61e'), 'name' => 'UID'],
            'uid_variant' => ['uri' => self::uri(), 'text' => self::skeleton('adf46a78-3c92-4c1e-cb04-7f791296e61e'), 'name' => 'UID'],
            'uid_short' => ['uri' => self::uri(), 'text' => self::skeleton('adf46a78-3c92-4c1e-ab04-7f791296e61'), 'name' => 'UID'],
            'uid_braced' => ['uri' => self::uri(), 'text' => self::skeleton('{' . self::UID . '}'), 'name' => 'UID'],
            'uid_mixed' => ['uri' => self::uri(), 'text' => self::secondEvent('5d6c7b8a-9012-4ef3-8abc-0123456789ab'), 'name' => 'UID'],
            'uid_alarm' => ['uri' => self::uri(), 'text' => self::alarm(strtoupper(self::UID)), 'name' => 'UID'],
            'uid_alarm_marker' => ['uri' => self::uri(), 'text' => self::alarm('CALFLEX_GUARD_MARKER_alarm_uid'), 'name' => 'UID'],
            'object_name_other' => ['uri' => '5d6c7b8a-9012-4ef3-8abc-0123456789ab.ics', 'text' => self::skeleton(), 'name' => 'OBJECT-NAME'],
            'object_name_uppercase' => ['uri' => strtoupper(self::uri()), 'text' => self::skeleton(), 'name' => 'OBJECT-NAME'],
            'object_name_suffix' => ['uri' => self::UID . '.ICS', 'text' => self::skeleton(), 'name' => 'OBJECT-NAME'],
            'object_name_extra' => ['uri' => self::uri() . '.bak', 'text' => self::skeleton(), 'name' => 'OBJECT-NAME'],
            'object_name_no_suffix' => ['uri' => self::UID, 'text' => self::skeleton(), 'name' => 'OBJECT-NAME'],
            'object_name_prefix' => ['uri' => 'x-' . self::uri(), 'text' => self::skeleton(), 'name' => 'OBJECT-NAME'],
            'object_name_marker' => ['uri' => 'CALFLEX_GUARD_MARKER_object_name.ics', 'text' => self::skeleton(), 'name' => 'OBJECT-NAME'],
            'rrule_x_part' => ['uri' => self::uri(), 'text' => self::eventLine('RRULE:FREQ=DAILY;X-NOTE=CALFLEX_GUARD_MARKER_rrule'), 'name' => 'RRULE'],
            'rrule_x_part_lowercase' => ['uri' => self::uri(), 'text' => self::eventLine('RRULE:FREQ=DAILY;x-note=CALFLEX_GUARD_MARKER_rrule'), 'name' => 'RRULE'],
            'rrule_x_part_only' => ['uri' => self::uri(), 'text' => self::eventLine('RRULE:X-EVERYDAY=1;FREQ=DAILY'), 'name' => 'RRULE'],
            // A `VTIMEZONE`'s own rule takes no `X-` part either.
            'rrule_x_part_timezone' => ['uri' => self::uri(), 'text' => str_replace('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'RRULE:FREQ=YEARLY;X-NOTE=1', self::allowed()['timezone']), 'name' => 'RRULE'],
        ];
    }

    /**
     * E03-R11 — updates in a Private calendar that are refused. The stored `UID`
     * is what the store holds; the body must keep it, and a `null` one is the
     * fail-closed row (a row without a `UID`, reachable only through the
     * backend, so the integration suite skips it and the unit suite pins it).
     *
     * @return array<string, array{text: string, stored: ?string, name: string}>
     */
    public static function objectUpdatesRejected(): array
    {
        return [
            'update_changed_uid' => ['text' => self::skeleton('5d6c7b8a-9012-4ef3-8abc-0123456789ab'), 'stored' => self::UID, 'name' => 'UID'],
            'update_uppercase_uid' => ['text' => self::skeleton(strtoupper(self::UID)), 'stored' => self::UID, 'name' => 'UID'],
            'update_uid_missing' => ['text' => str_replace('UID:' . self::UID . "\r\n", '', self::skeleton()), 'stored' => self::UID, 'name' => 'UID'],
            'update_uid_repaired' => ['text' => self::repairedSkeleton(), 'stored' => self::UID, 'name' => 'UID'],
            'update_uid_marker' => ['text' => self::skeleton('CALFLEX_GUARD_MARKER_uid'), 'stored' => self::UID, 'name' => 'UID'],
            'update_alarm_uid_marker' => ['text' => self::alarm('CALFLEX_GUARD_MARKER_alarm_uid'), 'stored' => self::UID, 'name' => 'UID'],
            'update_mixed_uid' => ['text' => self::secondEvent('5d6c7b8a-9012-4ef3-8abc-0123456789ab'), 'stored' => self::UID, 'name' => 'UID'],
            'update_stored_missing' => ['text' => self::skeleton(), 'stored' => null, 'name' => 'UID'],
            'update_rrule_x_part' => ['text' => self::eventLine('RRULE:FREQ=DAILY;X-NOTE=CALFLEX_GUARD_MARKER_rrule'), 'stored' => self::UID, 'name' => 'RRULE'],
        ];
    }

    /**
     * E03-R11 — creates that are accepted: a lowercase UUIDv4 with the name
     * `<uid>.ics`, an alarm with or without a `UID`, and the E03-R09 timezone
     * case whose `PRODID`, `TZID`, `TZNAME`, `TZURL` and `X-LIC-LOCATION` are
     * all values that are not UUIDv4 and stay unchecked.
     *
     * @return array<string, array{uri: string, text: string}>
     */
    public static function objectCreatesAllowed(): array
    {
        return [
            'uuid_v4' => ['uri' => self::uri(), 'text' => self::skeleton()],
            'alarm_without_uid' => ['uri' => self::uri(), 'text' => self::alarm(null)],
            'alarm_with_uid' => ['uri' => self::uri(), 'text' => self::alarm(self::UID)],
            'master_and_override' => ['uri' => self::uri(), 'text' => self::allowed()['master_and_override']],
            'unchecked_values' => ['uri' => self::uri(), 'text' => self::allowed()['timezone']],
        ];
    }

    /**
     * E03-R11 — updates that are accepted. The stored `UID` is the authority, so
     * an uppercase UUIDv4 or a version-7 UUID a stock app wrote while the
     * calendar was not Private is kept (INV-03), name and all.
     *
     * @return array<string, array{text: string, stored: string}>
     */
    public static function objectUpdatesAllowed(): array
    {
        return [
            'keeps_uuid_v4' => ['text' => self::skeleton(), 'stored' => self::UID],
            'keeps_stock_app_uppercase_uuid' => ['text' => self::skeleton('1A2B3C4D-5E6F-4A0B-8C1D-2E3F4A5B6C7D'), 'stored' => '1A2B3C4D-5E6F-4A0B-8C1D-2E3F4A5B6C7D'],
            'keeps_stock_app_version7' => ['text' => self::skeleton('9f2c4d31-6e08-7a55-b3c2-0d1e2f3a4b5c'), 'stored' => '9f2c4d31-6e08-7a55-b3c2-0d1e2f3a4b5c'],
            'keeps_legacy_alarm_without_uid' => ['text' => self::alarm(null), 'stored' => self::UID],
            'keeps_master_and_override' => ['text' => self::allowed()['master_and_override'], 'stored' => self::UID],
            'keeps_rdate' => ['text' => self::eventLine('RDATE:20261013T100000Z'), 'stored' => self::UID],
        ];
    }

    /** @return array<string, array{string, string}> */
    public static function rejected(): array
    {
        $cases = [];
        foreach (['SUMMARY', 'DESCRIPTION', 'LOCATION', 'ATTENDEE', 'ORGANIZER', 'ATTACH', 'COMMENT', 'CATEGORIES', 'URL', 'CONTACT', 'RESOURCES', 'GEO', 'CLASS', 'STATUS', 'X-APPLE-STRUCTURED-LOCATION', 'TRANSP', 'PRIORITY', 'X-ANYTHING'] as $name) {
            $cases[$name] = [self::eventLine($name . ':CALFLEX_GUARD_MARKER_' . $name), $name];
        }
        $cases['trailing_property'] = [self::skeleton() . "SUMMARY:CALFLEX_GUARD_MARKER_trailing\r\n", 'ICALENDAR'];
        $cases['trailing_document'] = [self::skeleton() . self::eventLine('SUMMARY:CALFLEX_GUARD_MARKER_trailing_document'), 'ICALENDAR'];
        $cases['grouped_property'] = [self::eventLine('PRIVATE.UID:CALFLEX_GUARD_MARKER_group'), 'UNLISTED'];
        $cases['lowercase'] = [self::eventLine('summary:CALFLEX_GUARD_MARKER_lowercase'), 'SUMMARY'];
        foreach (['X-SECRET', 'CN', 'RANGE', 'RELATED'] as $name) {
            $cases['param_' . $name] = [str_replace('DTSTART:', 'DTSTART;' . $name . '=CALFLEX_GUARD_MARKER_param_' . $name . ':', self::skeleton()), $name];
        }
        $cases['alarm'] = [self::eventLine("BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nDESCRIPTION:Reminder CALFLEX_GUARD_MARKER_alarm\r\nEND:VALARM"), 'DESCRIPTION'];
        $cases['action'] = [self::eventLine("BEGIN:VALARM\r\nACTION:CALFLEX_GUARD_MARKER_action\r\nEND:VALARM"), 'ACTION'];
        foreach (['VTODO', 'X-UNKNOWN'] as $name) {
            $cases[$name] = [str_replace('END:VCALENDAR', "BEGIN:$name\r\nSUMMARY:CALFLEX_GUARD_MARKER_$name\r\nEND:$name\r\nEND:VCALENDAR", self::skeleton()), $name];
        }
        foreach (['METHOD', 'CALSCALE'] as $name) {
            $cases[$name] = [str_replace('VERSION:2.0', "VERSION:2.0\r\n$name:CALFLEX_GUARD_MARKER_$name", self::skeleton()), $name];
        }
        $cases['missing_hash'] = [str_replace('X-CALFLEX-ENVELOPE-SHA256:' . str_repeat('a', 64) . "\r\n", '', str_replace('UID:adf46a78-3c92-4c1e-ab04-7f791296e61e', 'UID:CALFLEX_GUARD_MARKER_missing_hash', self::skeleton())), 'X-CALFLEX-ENVELOPE-SHA256'];
        foreach (['CALFLEX_GUARD_MARKER_hash', str_repeat('A', 64), str_repeat('a', 63), str_repeat('a', 64) . '\\n'] as $i => $hash) {
            $cases['hash_' . $i] = [str_replace(str_repeat('a', 64), $hash, self::skeleton()), 'X-CALFLEX-ENVELOPE-SHA256'];
        }
        foreach ([65, 128] as $length) {
            $cases['hash_length_' . $length] = [str_replace(str_repeat('a', 64), str_repeat('a', $length), self::skeleton()), 'X-CALFLEX-ENVELOPE-SHA256'];
        }
        $cases['parameter_related_wrong'] = [self::eventLine('UID;RELATED=CALFLEX_GUARD_MARKER_related:identifier'), 'RELATED'];
        $cases['parameter_range_wrong'] = [self::eventLine("BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER;RANGE=CALFLEX_GUARD_MARKER_range:-PT5M\r\nDESCRIPTION:Reminder\r\nEND:VALARM"), 'RANGE'];
        $cases['unknown_alarm_child'] = [self::eventLine("BEGIN:VALARM\r\nBEGIN:X-UNKNOWN\r\nSUMMARY:CALFLEX_GUARD_MARKER_alarm_child\r\nEND:X-UNKNOWN\r\nEND:VALARM"), 'X-UNKNOWN'];
        $cases['unknown_standard_child'] = [str_replace('END:VCALENDAR', "BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nBEGIN:STANDARD\r\nBEGIN:X-UNKNOWN\r\nSUMMARY:CALFLEX_GUARD_MARKER_standard_child\r\nEND:X-UNKNOWN\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nEND:VCALENDAR", self::skeleton()), 'X-UNKNOWN'];
        $cases['duplicate_hash'] = [self::eventLine('X-CALFLEX-ENVELOPE-SHA256:' . str_repeat('b', 64)), 'X-CALFLEX-ENVELOPE-SHA256'];
        $cases['override_hash'] = [str_replace('END:VCALENDAR', "BEGIN:VEVENT\r\nUID:CALFLEX_GUARD_MARKER_override_hash\r\nRECURRENCE-ID:20261013T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR", self::skeleton()), 'X-CALFLEX-ENVELOPE-SHA256'];
        $cases['standard_comment'] = [str_replace('END:VCALENDAR', "BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nBEGIN:STANDARD\r\nCOMMENT:CALFLEX_GUARD_MARKER_standard_comment\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nEND:VCALENDAR", self::skeleton()), 'COMMENT'];
        foreach (['VEVENT', 'VALARM', 'STANDARD', 'DAYLIGHT'] as $parent) {
            $nested = "BEGIN:$parent\r\nBEGIN:X-UNKNOWN\r\nSUMMARY:CALFLEX_GUARD_MARKER_nested_$parent\r\nEND:X-UNKNOWN\r\nEND:$parent";
            $cases['nested_' . $parent] = [$parent === 'VALARM' ? self::eventLine($nested) : str_replace('END:VCALENDAR', $nested . "\r\nEND:VCALENDAR", self::skeleton()), in_array($parent, ['STANDARD', 'DAYLIGHT'], true) ? $parent : 'X-UNKNOWN'];
        }
        return $cases;
    }

    /** @return array<string, string> */
    public static function allowed(): array
    {
        $cases = ['base' => self::skeleton()];
        foreach (['RRULE:FREQ=DAILY;COUNT=2', 'RDATE:20261013T100000Z', 'EXDATE:20261014T100000Z', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261013T100000Z', 'SEQUENCE:1', 'CREATED:20261009T080000Z', 'LAST-MODIFIED:20261009T080000Z', 'DTSTART;VALUE=DATE:20261012', 'DTSTART;TZID=Europe/Berlin:20261012T100000'] as $line) {
            $cases[$line] = self::eventLine($line);
        }
        $override = substr(self::skeleton(), strpos(self::skeleton(), 'BEGIN:VEVENT'));
        $override = str_replace('END:VCALENDAR' . "\r\n", '', $override);
        $override = str_replace('DTSTAMP:', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261013T100000Z' . "\r\nDTSTAMP:", $override);
        $cases['master_and_override'] = str_replace('END:VCALENDAR', $override . 'END:VCALENDAR', self::skeleton());
        $cases['duration'] = str_replace('DTEND:20261012T110000Z', 'DURATION:PT1H', self::skeleton());
        $cases['scale'] = str_replace('VERSION:2.0', "VERSION:2.0\r\nCALSCALE:GREGORIAN", self::skeleton());
        foreach (['DISPLAY', 'AUDIO'] as $action) {
            $cases[$action] = self::eventLine("BEGIN:VALARM\r\nACTION:$action\r\nTRIGGER;RELATED=END:-PT5M\r\nREPEAT:2\r\nDURATION:PT1M\r\nUID:adf46a78-3c92-4c1e-ab04-7f791296e61e\r\nDESCRIPTION:Reminder\r\nEND:VALARM");
        }
        $zone = "BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\nLAST-MODIFIED:20261009T080000Z\r\nTZURL:https://example.test/zone\r\nX-LIC-LOCATION:Europe/Berlin\r\n";
        foreach (['STANDARD', 'DAYLIGHT'] as $type) {
            $zone .= "BEGIN:$type\r\nDTSTART:20261025T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nRDATE:20271031T030000\r\nTZNAME:CET\r\nEND:$type\r\n";
        }
        $cases['timezone'] = str_replace('END:VCALENDAR', $zone . "END:VTIMEZONE\r\nEND:VCALENDAR", self::skeleton());
        return $cases;
    }
}
