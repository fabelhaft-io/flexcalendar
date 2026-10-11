<?php

declare(strict_types=1);

namespace Calflex\Tests;

use DateTimeImmutable;
use DateTimeZone;
use RuntimeException;
use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\Property;
use Sabre\VObject\Reader;
use Sabre\VObject\Recur\EventIterator;
use Sabre\VObject\Recur\NoInstancesException;

/**
 * E15-R03: expand the recurrence corpus with the CalDAV service's engine
 * (sabre/vobject, which SabreDAV uses for `calendar-query` time-range filters
 * and for each object's first and last occurrence).
 *
 * Normalisation is the same as the API-side runner in
 * `server/api/test/recurrence-corpus.mjs`, and both are documented in
 * `spec/ical-fixtures/rrule/README.md`:
 *   - a timed occurrence is the UTC instant of its start, `YYYYMMDDTHHMMSSZ`;
 *   - an all-day occurrence is its date, `YYYYMMDD`;
 *   - the window is half-open at UTC midnight: `2026-01-01T00:00:00Z` inclusive
 *     to `2031-01-01T00:00:00Z` exclusive;
 *   - an override (`RECURRENCE-ID` VEVENT) is reported in `overrides` with the
 *     start it moved to and the master occurrence key it replaced; that key is
 *     removed from `occurrences`; the override counts when the key it replaces
 *     is inside the window and its own start may lie outside it;
 *   - durations are dropped.
 *
 * Nothing here reads the wall clock, and stock-app event content never reaches
 * a log line: the fixtures carry the fixed summary "Recurrence case".
 *
 * `sabre/vobject` resolves a `TZID` through the calendar document's own
 * `VTIMEZONE` first and PHP's zone database second, so a fixture that uses a
 * `TZID` resolves either way.
 *
 * @phpstan-type Expansion array{fixture: string, occurrences: list<string>, overrides: list<array{start: string, replaces: string}>}
 */
final class RecurrenceCorpus
{
    /** Engine key used in the cross-engine comparison and in `RULINGS.md`. */
    public const string ENGINE = 'vobject';

    /** Inclusive start of the fixed window, canonical UTC form. */
    public const WINDOW_START = '20260101T000000Z';

    /** Exclusive end of the fixed window, as a canonical date. */
    public const WINDOW_END_DATE = '20310101';

    private const WINDOW_START_UTC = '2026-01-01T00:00:00Z';
    private const WINDOW_END_UTC = '2031-01-01T00:00:00Z';

    /** Hard stop for a rule the window never bounds. */
    private const MAX_INSTANCES = 20000;

    /** Human-readable rulings, next to the corpus. */
    public static function rulingsPath(): string
    {
        return dirname(__DIR__, 3) . '/spec/ical-fixtures/RULINGS.md';
    }

    public static function directory(): string
    {
        return dirname(__DIR__, 3) . '/spec/ical-fixtures/rrule';
    }

    /** @return list<string> */
    public static function fixtureIds(): array
    {
        $files = scandir(self::directory());
        if ($files === false) {
            throw new RuntimeException('Cannot read the recurrence corpus directory');
        }
        $ids = [];
        foreach ($files as $file) {
            if (str_ends_with($file, '.ics')) {
                $ids[] = substr($file, 0, -4);
            }
        }
        sort($ids);

        return $ids;
    }

    /**
     * @return array{fixture: string, occurrences: list<string>, overrides: list<array{start: string, replaces: string}>}
     */
    public static function expand(string $id): array
    {
        $path = self::directory() . '/' . $id . '.ics';
        $bytes = file_get_contents($path);
        if ($bytes === false) {
            throw new RuntimeException('Cannot read fixture: ' . $id);
        }
        $calendar = Reader::read($bytes);
        if (!$calendar instanceof VCalendar) {
            throw new RuntimeException($id . ': the fixture is not a VCALENDAR');
        }

        $masters = [];
        $overrides = [];
        foreach ($calendar->select('VEVENT') as $event) {
            if (!$event instanceof VEvent) {
                throw new RuntimeException($id . ': unexpected VEVENT representation');
            }
            if (count($event->select('RECURRENCE-ID')) > 0) {
                $overrides[] = $event;
            } else {
                $masters[] = $event;
            }
        }
        if (count($masters) !== 1) {
            throw new RuntimeException($id . ': expected exactly one master VEVENT');
        }

        $occurrences = self::expandMaster($id, $masters[0]);

        $replaced = [];
        $overrideEntries = [];
        foreach ($overrides as $override) {
            $recurrenceId = $override->select('RECURRENCE-ID')[0] ?? null;
            $startProperty = $override->select('DTSTART')[0] ?? null;
            if (!$recurrenceId instanceof Property\ICalendar\DateTime || !$startProperty instanceof Property\ICalendar\DateTime) {
                throw new RuntimeException($id . ': override VEVENT needs DTSTART and RECURRENCE-ID');
            }
            $replaces = self::canonical($recurrenceId);
            $replaced[$replaces] = true;
            if (self::inWindow($replaces)) {
                $overrideEntries[] = ['start' => self::canonical($startProperty), 'replaces' => $replaces];
            }
        }

        $keys = array_keys($replaced);
        $occurrences = array_values(array_filter(
            $occurrences,
            static function (string $occurrence) use ($keys): bool {
                return !in_array($occurrence, $keys, true);
            }
        ));
        sort($occurrences);
        usort(
            $overrideEntries,
            static function (array $left, array $right): int {
                return strcmp($left['replaces'], $right['replaces']);
            }
        );

        return ['fixture' => $id, 'occurrences' => $occurrences, 'overrides' => $overrideEntries];
    }

    /**
     * Write every fixture's normalised expansion as `<id>.json` under `directory`.
     *
     * @return list<string> the paths written
     */
    public static function writeOutput(string $directory): array
    {
        if (!is_dir($directory) && !mkdir($directory, 0777, true) && !is_dir($directory)) {
            throw new RuntimeException('Cannot create the corpus output directory');
        }
        $written = [];
        foreach (self::fixtureIds() as $id) {
            $path = $directory . '/' . $id . '.json';
            $json = json_encode(self::expand($id), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
            if ($json === false || file_put_contents($path, $json . "\n") === false) {
                throw new RuntimeException('Cannot write corpus output: ' . $id);
            }
            $written[] = $path;
        }

        return $written;
    }

    /**
     * The golden expectation written beside a fixture, or null when absent.
     *
     * @return array{fixture: string, occurrences: list<string>, overrides: list<array{start: string, replaces: string}>}|null
     */
    public static function expected(string $id): ?array
    {
        $path = self::directory() . '/' . $id . '.expected.json';
        if (!is_file($path)) {
            return null;
        }
        $bytes = file_get_contents($path);
        if ($bytes === false) {
            throw new RuntimeException('Cannot read golden expectation: ' . $id);
        }
        $decoded = json_decode($bytes, true);
        if (!is_array($decoded)) {
            throw new RuntimeException($id . ': the golden expectation is not a JSON object');
        }

        return [
            'fixture' => self::stringValue($decoded, 'fixture', $id),
            'occurrences' => self::stringList($decoded, 'occurrences', $id),
            'overrides' => self::overrideList($decoded, 'overrides', $id),
        ];
    }

    /**
     * Accepted engine deviations, parsed from the fenced JSON block in
     * `spec/ical-fixtures/RULINGS.md`, keyed by fixture id.
     *
     * @return array<string, array{type: string, index: int, icaljs: string|null, vobject: string|null, correct: string}>
     */
    public static function rulings(): array
    {
        $bytes = file_get_contents(self::rulingsPath());
        if ($bytes === false) {
            throw new RuntimeException('Cannot read RULINGS.md');
        }
        if (preg_match('/```json\s*\n(.*?)\n```/s', $bytes, $matches) !== 1) {
            throw new RuntimeException('RULINGS.md has no fenced json ruling block');
        }
        $decoded = json_decode($matches[1], true);
        if (!is_array($decoded) || !isset($decoded['rulings']) || !is_array($decoded['rulings'])) {
            throw new RuntimeException('RULINGS.md: rulings must be an array');
        }

        $rulings = [];
        foreach ($decoded['rulings'] as $index => $entry) {
            if (!is_array($entry)) {
                throw new RuntimeException('RULINGS.md: ruling ' . $index . ' is not an object');
            }
            $fixture = self::stringValue($entry, 'fixture', 'ruling ' . $index);
            $difference = $entry['firstDifference'] ?? null;
            if (!is_array($difference)) {
                throw new RuntimeException('RULINGS.md: ' . $fixture . ' has no firstDifference');
            }
            $type = self::stringValue($difference, 'type', $fixture);
            $position = $difference['index'] ?? null;
            if (!is_int($position)) {
                throw new RuntimeException('RULINGS.md: ' . $fixture . ' has no integer index');
            }
            if (isset($rulings[$fixture])) {
                throw new RuntimeException('RULINGS.md: duplicate ruling for ' . $fixture);
            }
            $rulings[$fixture] = [
                'type' => $type,
                'index' => $position,
                'icaljs' => self::nullableString($difference, 'icaljs', $fixture),
                'vobject' => self::nullableString($difference, 'vobject', $fixture),
                'correct' => self::stringValue($entry, 'correct', $fixture),
            ];
        }

        return $rulings;
    }

    public static function inWindow(string $canonical): bool
    {
        $date = substr($canonical, 0, 8);

        return $date >= substr(self::WINDOW_START, 0, 8) && $date < self::WINDOW_END_DATE;
    }

    /**
     * Whether this engine's expansion of one fixture is acceptable: it must
     * match the golden, or deviate from it exactly as `RULINGS.md` records and
     * be named as the wrong engine there. A ruling that no longer describes a
     * real deviation is a violation too, so a fixed engine cannot leave one
     * behind. The mirror image over both engines lives in
     * `infra/scripts/corpus-compare.mjs`.
     *
     * @param Expansion                                                        $actual
     * @param Expansion                                                        $expected
     * @param array{type: string, index: int, icaljs: string|null, vobject: string|null, correct: string}|null $ruling
     */
    public static function goldenViolation(string $id, array $actual, array $expected, ?array $ruling): string
    {
        $engine = self::ENGINE;
        $difference = self::firstDifference($actual, $expected);
        if ($difference === null) {
            if ($ruling !== null && $ruling['correct'] !== $engine) {
                return $id . ': the ruling records a deviation that ' . $engine . ' no longer produces';
            }

            return '';
        }

        $detail = $difference['type'] . ' ' . $difference['index'] . ': ' . $engine . ' gives '
            . ($difference['actual'] ?? '(absent)') . ', golden says ' . ($difference['expected'] ?? '(absent)');
        if ($ruling === null) {
            return $id . ': ' . $detail . ', and RULINGS.md has no ruling for it';
        }
        if ($ruling['correct'] === $engine) {
            return $id . ': ' . $detail . ', but the ruling names ' . $engine . ' as right';
        }
        if ($ruling['type'] !== $difference['type'] || $ruling['index'] !== $difference['index']) {
            return $id . ': ' . $detail . ', but the ruling records '
                . $ruling['type'] . ' ' . $ruling['index'];
        }
        /** @var array<string, string|null> $byEngine */
        $byEngine = ['icaljs' => $ruling['icaljs'], 'vobject' => $ruling['vobject']];
        $ruled = $byEngine[$engine];
        unset($byEngine[$engine]);
        $ruledOther = count($byEngine) === 1 ? array_values($byEngine)[0] : null;
        if ($ruled !== $difference['actual']) {
            return $id . ': ' . $detail . ', but the ruling records ' . $engine . ' at '
                . ($ruled ?? '(absent)');
        }
        if ($ruledOther !== $difference['expected']) {
            return $id . ': ' . $detail . ', but the ruling records the golden engine at '
                . ($ruledOther ?? '(absent)');
        }

        return '';
    }

    /**
     * @param Expansion $actual
     * @param Expansion $expected
     *
     * @return array{type: string, index: int, actual: string|null, expected: string|null}|null
     */
    private static function firstDifference(array $actual, array $expected): ?array
    {
        $count = max(count($actual['occurrences']), count($expected['occurrences']));
        for ($index = 0; $index < $count; ++$index) {
            $left = $actual['occurrences'][$index] ?? null;
            $right = $expected['occurrences'][$index] ?? null;
            if ($left !== $right) {
                return ['type' => 'occurrences', 'index' => $index, 'actual' => $left, 'expected' => $right];
            }
        }
        $count = max(count($actual['overrides']), count($expected['overrides']));
        for ($index = 0; $index < $count; ++$index) {
            $left = isset($actual['overrides'][$index]) ? self::overrideValue($actual['overrides'][$index]) : null;
            $right = isset($expected['overrides'][$index]) ? self::overrideValue($expected['overrides'][$index]) : null;
            if ($left !== $right) {
                return ['type' => 'overrides', 'index' => $index, 'actual' => $left, 'expected' => $right];
            }
        }

        return null;
    }

    /** @param array{start: string, replaces: string} $override */
    private static function overrideValue(array $override): string
    {
        return $override['start'] . '|' . $override['replaces'];
    }

    private static function canonical(Property\ICalendar\DateTime $property): string
    {
        /** @var DateTimeImmutable|null $dateTime */
        $dateTime = $property->getDateTime();
        if ($dateTime === null) {
            throw new RuntimeException('Cannot read the date-time value of ' . $property->name);
        }
        if ($property->hasTime()) {
            return $dateTime->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z');
        }

        return $dateTime->format('Ymd');
    }

    /** @return list<string> */
    private static function expandMaster(string $id, VEvent $master): array
    {
        $startProperty = $master->select('DTSTART')[0] ?? null;
        if (!$startProperty instanceof Property\ICalendar\DateTime) {
            throw new RuntimeException($id . ': the master VEVENT needs a DTSTART');
        }
        $allDay = !$startProperty->hasTime();

        try {
            $iterator = new EventIterator([$master], null, new DateTimeZone('UTC'));
        } catch (NoInstancesException) {
            return [];
        }

        $end = new DateTimeImmutable(self::WINDOW_END_UTC);
        $iterator->fastForward(new DateTimeImmutable(self::WINDOW_START_UTC));

        $occurrences = [];
        $guard = 0;
        while ($iterator->valid() && $guard < self::MAX_INSTANCES) {
            ++$guard;
            $current = $iterator->getDtStart();
            if ($current >= $end) {
                break;
            }
            $canonical = $allDay
                ? $current->setTimezone(new DateTimeZone('UTC'))->format('Ymd')
                : $current->setTimezone(new DateTimeZone('UTC'))->format('Ymd\THis\Z');
            if (self::inWindow($canonical)) {
                $occurrences[] = $canonical;
            }
            $iterator->next();
        }
        if ($guard >= self::MAX_INSTANCES) {
            throw new RuntimeException($id . ': recurrence expansion did not terminate');
        }

        return $occurrences;
    }

    /** @param array<mixed> $data */
    private static function stringValue(array $data, string $key, string $what): string
    {
        $value = $data[$key] ?? null;
        if (!is_string($value) || $value === '') {
            throw new RuntimeException($what . ': ' . $key . ' must be a non-empty string');
        }

        return $value;
    }

    /** @param array<mixed> $data */
    private static function nullableString(array $data, string $key, string $what): ?string
    {
        $value = $data[$key] ?? null;
        if ($value !== null && !is_string($value)) {
            throw new RuntimeException($what . ': ' . $key . ' must be a string or null');
        }

        return $value;
    }

    /**
     * @param array<mixed> $data
     *
     * @return list<string>
     */
    private static function stringList(array $data, string $key, string $what): array
    {
        $values = $data[$key] ?? null;
        if (!is_array($values)) {
            throw new RuntimeException($what . ': ' . $key . ' must be an array');
        }
        $list = [];
        foreach ($values as $value) {
            if (!is_string($value)) {
                throw new RuntimeException($what . ': ' . $key . ' must hold strings');
            }
            $list[] = $value;
        }

        return $list;
    }

    /**
     * @param array<mixed> $data
     *
     * @return list<array{start: string, replaces: string}>
     */
    private static function overrideList(array $data, string $key, string $what): array
    {
        $values = $data[$key] ?? null;
        if (!is_array($values)) {
            throw new RuntimeException($what . ': ' . $key . ' must be an array');
        }
        $list = [];
        foreach ($values as $value) {
            if (!is_array($value)) {
                throw new RuntimeException($what . ': ' . $key . ' must hold objects');
            }
            $list[] = [
                'start' => self::stringValue($value, 'start', $what),
                'replaces' => self::stringValue($value, 'replaces', $what),
            ];
        }

        return $list;
    }
}
