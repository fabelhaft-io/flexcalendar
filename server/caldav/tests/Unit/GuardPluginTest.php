<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\GuardPlugin;
use Calflex\PrivateSkeletonOnly;
use Calflex\Tests\GuardCases;
use Calflex\WriteGuard;
use PHPUnit\Framework\TestCase;
use Sabre\CalDAV\ICalendar;
use Sabre\CalDAV\ICalendarObject;

/**
 * E03-R11 — the pre-validation hook, called where SabreDAV calls it.
 *
 * `GuardPlugin` is what makes our `403` answer before `Sabre\CalDAV\Plugin`'s
 * own validation can answer a mixed-`UID` body with a `415`; that ordering is
 * pinned over HTTP by `tests/Integration/GuardTest.php`. This file pins the
 * hook's own decision: it guards a Private collection and nothing else, so a
 * Shared or Published write — and a collection that is not a calendar at all —
 * is untouched, and it reads the stored `UID` for an update so a stock-app
 * `UID` written while the calendar was not Private is kept (INV-03).
 */
final class GuardPluginTest extends TestCase
{
    private const CALENDAR = 'adf46a78-3c92-4c1e-ab04-7f791296e61e';

    /** @param array<string, string> $modes */
    private function plugin(array $modes): GuardPlugin
    {
        return new GuardPlugin(new WriteGuard(static fn (string $id): ?string => $modes[$id] ?? null));
    }

    private function path(string $calendar, string $object): string
    {
        return 'calendars/00000000-0000-4000-8000-000000000000/' . $calendar . '/' . $object;
    }

    private function calendar(): ICalendar
    {
        return $this->createStub(ICalendar::class);
    }

    private function object(string $stored): ICalendarObject
    {
        $node = $this->createStub(ICalendarObject::class);
        $node->method('get')->willReturn($stored);

        return $node;
    }

    public function testAPrivateCalendarIsGuardedOnCreate(): void
    {
        $plugin = $this->plugin([self::CALENDAR => 'private']);
        $modified = false;
        $body = GuardCases::skeleton('CALFLEX_GUARD_MARKER_uid');
        try {
            $plugin->beforeCreateFile($this->path(self::CALENDAR, 'anything.ics'), $body, $this->calendar(), $modified);
            self::fail('A Private create with a non-UUID UID passed the hook');
        } catch (PrivateSkeletonOnly $exception) {
            self::assertSame('UID', $exception->name);
        }
        // The accepted shape is not refused, and a stream body is left as the
        // string the handlers after this one need.
        $stream = fopen('php://temp', 'r+');
        self::assertNotFalse($stream);
        fwrite($stream, GuardCases::skeleton());
        rewind($stream);
        $plugin->beforeCreateFile($this->path(self::CALENDAR, GuardCases::uri()), $stream, $this->calendar(), $modified);
        self::assertIsString($stream);
        self::assertStringContainsString('BEGIN:VCALENDAR', $stream);
    }

    public function testASharedCalendarIsUntouched(): void
    {
        // A `UID` that names an event, a name that is not `<uid>.ics` and a
        // marker in every refused position: none is the hook's business on a
        // Shared or Published collection, or on a URI the guard has no rule for.
        $body = GuardCases::skeleton('CALFLEX_GUARD_MARKER_uid');
        foreach ([['shared', self::CALENDAR], ['published', self::CALENDAR], [null, 'not-a-uuid']] as [$mode, $calendar]) {
            $plugin = $this->plugin($mode === null ? [] : [self::CALENDAR => $mode]);
            $modified = false;
            $stream = fopen('php://temp', 'r+');
            self::assertNotFalse($stream);
            fwrite($stream, $body);
            rewind($stream);
            $plugin->beforeCreateFile($this->path($calendar, 'CALFLEX_GUARD_MARKER_object_name.ics'), $stream, $this->calendar(), $modified);
            self::assertIsResource($stream, 'A non-Private write must not be read');
            fclose($stream);
        }
    }

    public function testANonCalendarCollectionIsUntouched(): void
    {
        $plugin = $this->plugin([self::CALENDAR => 'private']);
        $modified = false;
        // A write to a collection that is not a calendar (the home, an outbox)
        // is never the guard's to refuse.
        $parent = $this->createStub(\Sabre\DAV\ICollection::class);
        $body = GuardCases::skeleton('CALFLEX_GUARD_MARKER_uid');
        $plugin->beforeCreateFile($this->path(self::CALENDAR, 'anything.ics'), $body, $parent, $modified);
        self::assertFalse($modified);
        self::assertSame(GuardCases::skeleton('CALFLEX_GUARD_MARKER_uid'), $body);
    }

    public function testAnUpdateKeepsTheStoredUid(): void
    {
        $plugin = $this->plugin([self::CALENDAR => 'private']);
        $modified = false;
        $legacy = '1A2B3C4D-5E6F-4A0B-8C1D-2E3F4A5B6C7D';
        // The stored `UID` rules; the body keeps it whatever its shape, and the
        // object name is not re-checked on an update.
        $keeps = GuardCases::skeleton($legacy);
        $plugin->beforeWriteContent($this->path(self::CALENDAR, 'kept-name.ics'), $this->object($keeps), $keeps, $modified);
        $changes = GuardCases::skeleton();
        try {
            $plugin->beforeWriteContent($this->path(self::CALENDAR, GuardCases::uri()), $this->object($keeps), $changes, $modified);
            self::fail('An update that changes the stored UID passed the hook');
        } catch (PrivateSkeletonOnly $exception) {
            self::assertSame('UID', $exception->name);
        }
        self::assertFalse($modified);
    }

    /**
     * A body Sabre's own reader cannot parse, or that is not a `VCALENDAR`, is
     * left to `Sabre\CalDAV\Plugin::validateICalendar` — the `415` a broken body
     * has always got, not a `403` this guard would have to invent a name for.
     * The hook still turns the request stream into the string that handler
     * expects, exactly as it does, and marks no modification.
     */
    public function testABrokenOrNonCalendarBodyIsLeftToSabre(): void
    {
        $plugin = $this->plugin([self::CALENDAR => 'private']);
        foreach (["BEGIN:VCALENDAR\r\nCALFLEX_GUARD_MARKER_broken\r\nEND:VCALENDAR", '', "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:CALFLEX_GUARD_MARKER_card\r\nEND:VCARD\r\n"] as $body) {
            $modified = false;
            $stream = fopen('php://temp', 'r+');
            self::assertNotFalse($stream);
            fwrite($stream, $body);
            rewind($stream);
            $plugin->beforeCreateFile($this->path(self::CALENDAR, GuardCases::uri()), $stream, $this->calendar(), $modified);
            self::assertFalse($modified);
            self::assertSame($body, $stream);
        }
        // A Shared collection is not read at all, and an update's stored bytes
        // are only parsed where the body itself is a Private object.
        $untouched = fopen('php://temp', 'r+');
        self::assertNotFalse($untouched);
        fwrite($untouched, 'not iCalendar');
        rewind($untouched);
        $modified = false;
        $this->plugin([self::CALENDAR => 'shared'])->beforeWriteContent($this->path(self::CALENDAR, 'x.ics'), $this->object('not iCalendar'), $untouched, $modified);
        self::assertIsResource($untouched);
        fclose($untouched);
        $modified = false;
        $broken = 'not iCalendar';
        $this->plugin([self::CALENDAR => 'private'])->beforeWriteContent($this->path(self::CALENDAR, 'x.ics'), $this->object(GuardCases::skeleton()), $broken, $modified);
        self::assertFalse($modified);
    }
}
