<?php

declare(strict_types=1);

namespace Calflex\Tests;

final class GuardCases
{
    public static function skeleton(): string
    {
        return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Calflex//EN\r\nBEGIN:VEVENT\r\nUID:adf46a78-3c92-4c1e-ab04-7f791296e61e\r\nDTSTAMP:20261009T080000Z\r\nDTSTART:20261012T100000Z\r\nDTEND:20261012T110000Z\r\nX-CALFLEX-ENVELOPE-SHA256:" . str_repeat('a', 64) . "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    }

    public static function eventLine(string $line): string
    {
        return str_replace('END:VEVENT', $line . "\r\nEND:VEVENT", self::skeleton());
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
