<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\PrivateSkeleton;
use Calflex\SkeletonViolation;
use PHPUnit\Framework\TestCase;

/**
 * E15-R01: the `ours/` half of the round-trip corpus is what our own code
 * writes, so every fixture in it has to be a Private skeleton — the allow-list
 * E03-R09 defines and `Calflex\PrivateSkeleton` enforces, where
 * `X-CALFLEX-ENVELOPE-SHA256` stands in for the content the skeleton does not
 * carry. The `synthetic/` half imitates other writers' objects; those are the
 * objects a Private calendar refuses, which is the same contrast the stack
 * check sees when it PUTs one of each.
 *
 * The fixtures are test data of `spec/ical-fixtures/`, never product code. The
 * engine-side half of the gate — read each fixture, write it back, fail on a
 * lost component, property or parameter (INV-02) — lives in
 * `server/api/test/ical-roundtrip.test.mjs`.
 */
final class PrivateSkeletonCorpusTest extends TestCase
{
    /** The content properties a stock-app object carries and a skeleton must not. */
    private const CONTENT_PROPERTIES = ['SUMMARY', 'DESCRIPTION', 'LOCATION', 'ATTENDEE', 'ORGANIZER', 'CATEGORIES', 'TRANSP'];

    /** @return list<string> absolute paths of one source's `.ics` fixtures, sorted */
    private static function fixtures(string $source): array
    {
        $files = glob(dirname(__DIR__, 4) . '/spec/ical-fixtures/' . $source . '/*.ics');
        self::assertIsArray($files, $source . ': cannot read the fixture directory');
        self::assertNotEmpty($files, $source . ': no fixtures');
        sort($files);

        return $files;
    }

    private static function text(string $file): string
    {
        $text = file_get_contents($file);
        self::assertIsString($text, $file . ': cannot read the fixture');

        return $text;
    }

    public function testEveryOursFixtureIsAcceptedAsAPrivateSkeleton(): void
    {
        foreach (self::fixtures('ours') as $file) {
            PrivateSkeleton::calendar(self::text($file));
        }
    }

    public function testAnOursFixtureWithContentAddedIsRejected(): void
    {
        $text = self::text(self::fixtures('ours')[0]);
        $withSummary = str_replace('DTSTAMP:', "SUMMARY:CALFLEX_GUARD_MARKER_ours\r\nDTSTAMP:", $text);
        self::assertNotSame($text, $withSummary);
        try {
            PrivateSkeleton::calendar($withSummary);
            self::fail('A fixture with a SUMMARY added passed the skeleton guard');
        } catch (SkeletonViolation $exception) {
            self::assertSame('SUMMARY', $exception->name);
        }
    }

    public function testEverySyntheticFixtureIsRefusedAsAPrivateSkeleton(): void
    {
        foreach (self::fixtures('synthetic') as $file) {
            try {
                PrivateSkeleton::calendar(self::text($file));
                self::fail($file . ': a stock-app object passed the Private skeleton guard');
            } catch (SkeletonViolation $exception) {
                self::assertContains($exception->name, self::CONTENT_PROPERTIES, $file);
            }
        }
    }
}
