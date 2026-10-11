<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Tests\RecurrenceCorpus;
use PHPUnit\Framework\TestCase;

/**
 * E15-R03: the CalDAV service's own gate over the recurrence corpus.
 *
 * `sabre/vobject` is the engine stock apps' `calendar-query` time-range filters
 * go through, so a dependency bump in `server/caldav` that changes recurrence
 * expansion fails here, in this component, before the cross-engine comparison
 * runs. A fixture this engine is known to get wrong keeps its RFC-derived
 * golden and `spec/ical-fixtures/RULINGS.md` pins the deviation; it is never
 * skipped.
 */
final class RecurrenceCorpusTest extends TestCase
{
    public function testCorpusHolds25To40Fixtures(): void
    {
        $count = count(RecurrenceCorpus::fixtureIds());
        self::assertGreaterThanOrEqual(25, $count);
        self::assertLessThanOrEqual(40, $count);
    }

    public function testEveryFixtureMatchesItsGoldenExpectation(): void
    {
        $rulings = RecurrenceCorpus::rulings();
        foreach (RecurrenceCorpus::fixtureIds() as $id) {
            $expected = RecurrenceCorpus::expected($id);
            self::assertNotNull($expected, $id . ': no golden expectation beside the fixture');
            self::assertSame($id, $expected['fixture']);
            $violation = RecurrenceCorpus::goldenViolation($id, RecurrenceCorpus::expand($id), $expected, $rulings[$id] ?? null);
            self::assertSame('', $violation);
        }
    }

    public function testEveryRulingNamesAFixtureOfTheCorpus(): void
    {
        foreach (array_keys(RecurrenceCorpus::rulings()) as $fixture) {
            self::assertContains($fixture, RecurrenceCorpus::fixtureIds());
        }
    }

    public function testEveryFixtureHasAGoldenExpectationAndEveryGoldenAFixture(): void
    {
        $goldens = [];
        foreach (scandir(RecurrenceCorpus::directory()) ?: [] as $file) {
            if (str_ends_with($file, '.expected.json')) {
                $goldens[] = substr($file, 0, -strlen('.expected.json'));
            }
        }
        sort($goldens);
        self::assertSame(RecurrenceCorpus::fixtureIds(), $goldens);
    }

    public function testEveryGoldenIsSortedUniqueAndInsideTheWindow(): void
    {
        foreach (RecurrenceCorpus::fixtureIds() as $id) {
            $expected = RecurrenceCorpus::expected($id);
            self::assertNotNull($expected);
            $previous = null;
            foreach ($expected['occurrences'] as $occurrence) {
                self::assertMatchesRegularExpression('/^\d{8}(T\d{6}Z)?$/', $occurrence);
                self::assertTrue(RecurrenceCorpus::inWindow($occurrence), $id . ': ' . $occurrence . ' is outside the window');
                if ($previous !== null) {
                    self::assertLessThan(0, strcmp($previous, $occurrence), $id . ': golden is not sorted or not unique');
                }
                $previous = $occurrence;
            }
        }
    }

    public function testExpansionsAreSortedAndInsideTheWindow(): void
    {
        foreach (RecurrenceCorpus::fixtureIds() as $id) {
            $occurrences = RecurrenceCorpus::expand($id)['occurrences'];
            $previous = null;
            foreach ($occurrences as $occurrence) {
                self::assertMatchesRegularExpression('/^\d{8}(T\d{6}Z)?$/', $occurrence);
                self::assertTrue(RecurrenceCorpus::inWindow($occurrence), $id . ': ' . $occurrence . ' is outside the window');
                if ($previous !== null) {
                    // A duplicate is an engine bug a ruling pins, not a normalisation error.
                    self::assertLessThanOrEqual(0, strcmp($previous, $occurrence), $id . ': not sorted');
                }
                $previous = $occurrence;
            }
        }
    }

    public function testGoldenViolationPinsADeviationOnlyWhenRuled(): void
    {
        $golden = ['fixture' => 'case', 'occurrences' => ['A', 'B', 'C'], 'overrides' => []];
        $equal = ['fixture' => 'case', 'occurrences' => ['A', 'B', 'C'], 'overrides' => []];
        $deviating = ['fixture' => 'case', 'occurrences' => ['A', 'Z', 'C'], 'overrides' => []];
        $ruling = ['type' => 'occurrences', 'index' => 1, 'icaljs' => 'B', 'vobject' => 'Z', 'correct' => 'icaljs'];

        self::assertSame('', RecurrenceCorpus::goldenViolation('case', $equal, $golden, null));
        self::assertStringContainsString('RULINGS.md has no ruling', RecurrenceCorpus::goldenViolation('case', $deviating, $golden, null));
        self::assertSame('', RecurrenceCorpus::goldenViolation('case', $deviating, $golden, $ruling));
        self::assertStringContainsString(
            'no longer produces',
            RecurrenceCorpus::goldenViolation('case', $equal, $golden, $ruling)
        );
        self::assertStringContainsString('names vobject as right', RecurrenceCorpus::goldenViolation('case', $deviating, $golden, array_merge($ruling, ['correct' => 'vobject'])));
        self::assertStringContainsString('records occurrences 2', RecurrenceCorpus::goldenViolation('case', $deviating, $golden, array_merge($ruling, ['index' => 2])));
        self::assertStringContainsString('records vobject at Y', RecurrenceCorpus::goldenViolation('case', $deviating, $golden, array_merge($ruling, ['vobject' => 'Y'])));
        $moved = ['fixture' => 'case', 'occurrences' => [], 'overrides' => [['start' => 'S', 'replaces' => 'R']]];
        self::assertStringContainsString(
            'overrides 0: vobject gives S|R',
            RecurrenceCorpus::goldenViolation('case', $moved, ['fixture' => 'case', 'occurrences' => [], 'overrides' => []], null)
        );
    }

    public function testExpansionIsDeterministic(): void
    {
        $ids = RecurrenceCorpus::fixtureIds();
        foreach ($ids as $id) {
            self::assertSame(RecurrenceCorpus::expand($id), RecurrenceCorpus::expand($id), $id);
        }
    }

    public function testWritesNormalisedOutputWhenRequested(): void
    {
        $directory = getenv('CALFLEX_CORPUS_OUT');
        if ($directory === false || $directory === '') {
            self::markTestSkipped('CALFLEX_CORPUS_OUT is not set; infra/scripts/corpus-compare.mjs sets it.');
        }
        $written = RecurrenceCorpus::writeOutput($directory);
        self::assertCount(count(RecurrenceCorpus::fixtureIds()), $written);
        foreach ($written as $path) {
            self::assertFileExists($path);
        }
    }
}
