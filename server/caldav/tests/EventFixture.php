<?php

declare(strict_types=1);

namespace Calflex\Tests;

final class EventFixture
{
    public static function create(string $uid): string
    {
        // tzurl/IANA fixture; recurrence expansion belongs to sabre/vobject.
        /** @var \Sabre\VObject\Component\VCalendar $calendar */
        $calendar = \Sabre\VObject\Reader::read((string) file_get_contents(__DIR__ . '/Fixtures/Europe-Berlin.ics'));
        // The upstream timezone contains an extension outside the Private allow-list.
        foreach ($calendar->select('VTIMEZONE') as $zone) {
            unset($zone->{'X-PROLEPTIC-TZNAME'});
        }
        /** @var \Sabre\VObject\Component $event */
        $event = $calendar->add('VEVENT', [
            'UID' => $uid, 'DTSTAMP' => '20261009T080000Z',
            'DTSTART' => '20261012T100000', 'DTEND' => '20261012T110000',
            'RRULE' => 'FREQ=DAILY;COUNT=5', 'X-CALFLEX-ENVELOPE-SHA256' => str_repeat('a', 64),
        ]);
        $event->select('DTSTART')[0]['TZID'] = 'Europe/Berlin';
        $event->select('DTEND')[0]['TZID'] = 'Europe/Berlin';
        return $calendar->serialize();
    }

}
