<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\DAV\PropPatch;

final class GuardedCalendars extends \Sabre\CalDAV\Backend\PDO
{
    public function __construct(\PDO $pdo, private readonly WriteGuard $guard)
    {
        parent::__construct($pdo);
    }

    /** @param array<string, mixed> $properties */
    public function createCalendar($principalUri, $calendarUri, array $properties)
    {
        $this->guard->properties($calendarUri, $properties);
        return parent::createCalendar($principalUri, $calendarUri, $properties);
    }

    public function updateCalendar($calendarId, PropPatch $propPatch): void
    {
        $this->guard->properties($this->uri($calendarId), $propPatch->getMutations());
        parent::updateCalendar($calendarId, $propPatch);
    }

    public function createCalendarObject($calendarId, $objectUri, $calendarData)
    {
        $this->guard->calendar($this->uri($calendarId), $calendarData);
        return parent::createCalendarObject($calendarId, $objectUri, $calendarData);
    }

    public function updateCalendarObject($calendarId, $objectUri, $calendarData)
    {
        $this->guard->calendar($this->uri($calendarId), $calendarData);
        return parent::updateCalendarObject($calendarId, $objectUri, $calendarData);
    }

    /** @param array{0: mixed, 1: mixed} $calendarId */
    private function uri(array $calendarId): string
    {
        $query = $this->pdo->prepare('SELECT uri FROM ' . $this->calendarInstancesTableName . ' WHERE id = ? AND calendarid = ?');
        $query->execute([$calendarId[1], $calendarId[0]]);
        $uri = $query->fetchColumn();
        return is_string($uri) ? $uri : '';
    }
}
