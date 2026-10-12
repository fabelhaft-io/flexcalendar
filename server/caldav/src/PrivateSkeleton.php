<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\VObject\Component;

/** Allow-list only; RFC validation and recurrence remain Sabre's responsibility. */
final class PrivateSkeleton
{
    /**
     * E03-R11 — the lowercase UUIDv4 a `UID` must be when an object is created
     * in a Private calendar. Anchored, and deliberately without `/i`: the rule
     * is a lowercase UUIDv4, so SabreDAV's repair value `sabre-vobject-<uuid>`
     * and an uppercase stock-app `UID` both fail it.
     */
    private const UID = '/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/';

    /** The name token the E03-R11 object-name refusal carries (never a value). */
    private const OBJECT_NAME = 'OBJECT-NAME';

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
        self::component(self::root($text));
    }

    /**
     * E03-R11 — the value backstop beside the E03-R09 allow-list. The allow-list
     * checks names, not values, and of the free-text values it leaves alone the
     * `UID` is the one that travels: into the object name, the outbox, the delta
     * feed, log correlations and the sidecar key. So a create in a Private
     * calendar needs
     *
     *  - a lowercase UUIDv4 `UID` on every `VEVENT`, and on every `VALARM` that
     *    carries one (the API's own skeletons write an alarm without a `UID`,
     *    and `spec/ical-fixtures/ours/private-valarm.ics` is exactly that, so a
     *    `VALARM` is not required to have one);
     *  - one `UID` across all `VEVENT`s;
     *  - the object name `<uid>.ics`, exactly, as the backend receives it.
     *
     * A `PUT` without a `UID` is refused either way: without SabreDAV's repair
     * our own walk finds no `UID`, and after it the body carries
     * `sabre-vobject-<uuid>`, which is not a UUIDv4. An `RRULE` takes no `X-`
     * rule part (RFC 5545 § 3.3.10 allows `x-name`, and a rule part is another
     * value a client chooses). `PRODID`, `TZID`, `X-LIC-LOCATION`, `TZNAME` and
     * `TZURL` stay unchecked: the API writes them from its own data.
     *
     * `$objectUri` is the last segment of the request URI, decoded, exactly as
     * SabreDAV hands it to the backend — the same string it stores, so the
     * comparison is against what a later `GET` would be addressed with.
     */
    public static function createObject(string $objectUri, string $text): void
    {
        $root = self::root($text);
        self::component($root);
        $uid = self::uid($root);
        if (preg_match(self::UID, $uid) !== 1) {
            throw new SkeletonViolation('UID');
        }
        if ($objectUri !== $uid . '.ics') {
            throw new SkeletonViolation(self::OBJECT_NAME);
        }
        self::ruleParts($root);
    }

    /**
     * E03-R11 — an update keeps the `UID` the store already holds, whatever
     * shape that has: a Shared calendar switched to Private keeps its stock-app
     * `UID`s (INV-03), so the stored value is the authority and never the
     * lowercase-UUIDv4 rule that a create applies. Changing it — including a
     * body SabreDAV's repair gave a fresh `sabre-vobject-<uuid>` — is refused,
     * as is a body without a `UID` and an `RRULE` with an `X-` rule part. The
     * object name is not checked: an object that was not created under E03-R11
     * keeps the name it has. A `$storedUid` of `null` (a row without one) is
     * refused, never treated as "anything goes".
     */
    public static function updateObject(?string $storedUid, string $text): void
    {
        $root = self::root($text);
        self::component($root);
        $uid = self::uid($root);
        if ($storedUid === null || $uid !== $storedUid) {
            throw new SkeletonViolation('UID');
        }
        self::ruleParts($root);
    }

    private static function root(string $text): Component
    {
        try {
            $root = (new SkeletonParser())->parse($text);
        } catch (\Throwable) {
            throw new SkeletonViolation('ICALENDAR');
        }
        if ($root->name !== 'VCALENDAR') {
            throw new SkeletonViolation('VCALENDAR');
        }

        return $root;
    }

    /**
     * The one `UID` an object's `VEVENT`s carry, checked for presence, sameness
     * and — where a `VALARM` has one — the UUIDv4 shape. The value itself never
     * reaches the violation: `SkeletonViolation` names `UID`.
     */
    private static function uid(Component $root): string
    {
        $uid = null;
        foreach ($root->children() as $child) {
            if (!($child instanceof Component) || $child->name !== 'VEVENT') {
                continue;
            }
            $value = $child->select('UID')[0] ?? null;
            if (!$value instanceof \Sabre\VObject\Property) {
                throw new SkeletonViolation('UID');
            }
            $eventUid = (string) $value;
            if ($uid === null) {
                $uid = $eventUid;
            } elseif ($uid !== $eventUid) {
                throw new SkeletonViolation('UID');
            }
            foreach ($child->children() as $alarm) {
                if (!($alarm instanceof Component) || $alarm->name !== 'VALARM') {
                    continue;
                }
                $alarmUid = $alarm->select('UID')[0] ?? null;
                if ($alarmUid instanceof \Sabre\VObject\Property && preg_match(self::UID, (string) $alarmUid) !== 1) {
                    throw new SkeletonViolation('UID');
                }
            }
        }
        if ($uid === null) {
            // No `VEVENT`, or one without a `UID`: a PUT without a `UID` is a
            // refusal create and update alike.
            throw new SkeletonViolation('UID');
        }

        return $uid;
    }

    /** RFC 5545 § 3.3.10 allows an `x-name` rule part; a Private skeleton does not. */
    private static function ruleParts(Component $component): void
    {
        foreach ($component->children() as $child) {
            if ($child instanceof Component) {
                self::ruleParts($child);
                continue;
            }
            if ($child->name !== 'RRULE') {
                continue;
            }
            $value = $child->getValue();
            foreach (explode(';', is_string($value) ? $value : '') as $part) {
                if (str_starts_with(strtoupper(explode('=', $part, 2)[0]), 'X-')) {
                    throw new SkeletonViolation('RRULE');
                }
            }
        }
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
