<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\VObject\Component;

/** Allow-list only; RFC validation and recurrence remain Sabre's responsibility. */
final class PrivateSkeleton
{
    private const PROPERTIES = [
        'VCALENDAR' => ['VERSION', 'PRODID', 'CALSCALE'],
        'VTIMEZONE' => ['TZID', 'LAST-MODIFIED', 'TZURL', 'X-LIC-LOCATION'],
        'STANDARD' => ['DTSTART', 'TZOFFSETFROM', 'TZOFFSETTO', 'RRULE', 'RDATE', 'TZNAME'],
        'DAYLIGHT' => ['DTSTART', 'TZOFFSETFROM', 'TZOFFSETTO', 'RRULE', 'RDATE', 'TZNAME'],
        'VEVENT' => ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID', 'SEQUENCE', 'CREATED', 'LAST-MODIFIED', 'X-CALFLEX-ENVELOPE-SHA256'],
        'VALARM' => ['ACTION', 'TRIGGER', 'REPEAT', 'DURATION', 'UID', 'DESCRIPTION'],
    ];
    private const COMPONENTS = [
        'VCALENDAR' => ['VEVENT', 'VTIMEZONE'], 'VEVENT' => ['VALARM'],
        'VTIMEZONE' => ['STANDARD', 'DAYLIGHT'], 'VALARM' => [], 'STANDARD' => [], 'DAYLIGHT' => [],
    ];

    public static function calendar(string $text): void
    {
        try {
            $root = (new SkeletonParser())->parse($text);
        } catch (\Throwable) {
            throw new SkeletonViolation('ICALENDAR');
        }
        if ($root->name !== 'VCALENDAR') {
            throw new SkeletonViolation('VCALENDAR');
        }
        self::component($root);
    }

    private static function component(Component $component): void
    {
        $hashes = 0;
        foreach ($component->children() as $child) {
            $name = $child->name;
            if ($child instanceof Component) {
                if (!in_array($name, self::COMPONENTS[$component->name], true)) {
                    throw new SkeletonViolation($name);
                }
                self::component($child);
                continue;
            }
            if ($child->group !== null) {
                throw new SkeletonViolation('UNLISTED');
            }
            if (!in_array($name, self::PROPERTIES[$component->name], true)) {
                throw new SkeletonViolation($name);
            }
            foreach ($child->parameters() as $parameter) {
                if (!in_array($parameter->name, ['TZID', 'VALUE'], true)
                    && !($parameter->name === 'RANGE' && $name === 'RECURRENCE-ID')
                    && !($parameter->name === 'RELATED' && $name === 'TRIGGER')) {
                    throw new SkeletonViolation($parameter->name);
                }
            }
            $value = $child->getValue();
            if (($name === 'CALSCALE' && $value !== 'GREGORIAN')
                || ($component->name === 'VALARM' && $name === 'DESCRIPTION' && $value !== 'Reminder')
                || ($component->name === 'VALARM' && $name === 'ACTION' && !in_array($value, ['DISPLAY', 'AUDIO'], true))) {
                throw new SkeletonViolation($name);
            }
            if ($name === 'X-CALFLEX-ENVELOPE-SHA256') {
                ++$hashes;
                if (!is_string($value) || preg_match('/\A[0-9a-f]{64}\z/', $value) !== 1) {
                    throw new SkeletonViolation($name);
                }
            }
        }
        if ($component->name === 'VEVENT' && $hashes !== 1) {
            throw new SkeletonViolation('X-CALFLEX-ENVELOPE-SHA256');
        }
    }

    /** @param array<string, mixed> $properties */
    public static function properties(array $properties, bool $collection = true): void
    {
        foreach ($properties as $name => $value) {
            if (!$collection || $name !== '{DAV:}displayname' || $value !== 'Private calendar') {
                // Clark notation is parsed by Sabre; only expose a safe local name.
                $end = strrpos($name, '}');
                $local = $end === false ? $name : substr($name, $end + 1);
                throw new SkeletonViolation(strtoupper($local));
            }
        }
    }
}
