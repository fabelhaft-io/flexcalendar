<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Tests\EventFixture;
use PHPUnit\Framework\TestCase;

final class EventFixtureTest extends TestCase
{
    public function testRecurringFixtureHasAnInstanceAwayFromMaster(): void
    {
        $bytes = EventFixture::create('8b0e189c-43a5-4f1e-a810-5c4b5c021593');
        /** @var \Sabre\VObject\Component\VCalendar $calendar */
        $calendar = \Sabre\VObject\Reader::read($bytes);
        self::assertCount(1, $calendar->select('VTIMEZONE'));
        $events = $calendar->select('VEVENT');
        self::assertCount(1, $events);
        self::assertSame('Europe/Berlin', (string) $events[0]->select('DTSTART')[0]['TZID']);
        $expanded = $calendar->expand(new \DateTime('2026-10-14T07:30:00Z'), new \DateTime('2026-10-14T09:30:00Z'));
        self::assertCount(1, $expanded->select('VEVENT'));
    }
}
