<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\DAV\PropPatch;

class GuardedCalendars extends \Sabre\CalDAV\Backend\PDO
{
    public function __construct(\PDO $pdo, private readonly WriteGuard $guard)
    {
        parent::__construct($pdo);
        // Schema-qualified, the same names Service::create configures, so a
        // backend constructed outside it (the test writer process) reaches the
        // sabredav tables rather than public.*.
        $this->calendarTableName = 'sabredav.calendars';
        $this->calendarInstancesTableName = 'sabredav.calendarinstances';
        $this->calendarObjectTableName = 'sabredav.calendarobjects';
        $this->calendarChangesTableName = 'sabredav.calendarchanges';
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
        $collection = $this->collection($calendarId);
        $this->begin($calendarId);
        try {
            $result = parent::createCalendarObject($calendarId, $objectUri, $calendarData);
            $this->afterObjectWrite($calendarId, $objectUri);
            $this->append($collection, $this->objectUid($calendarId, $objectUri), 'created', $calendarId);
            $this->pdo->commit();
            return $result;
        } catch (\Throwable $exception) {
            $this->rollBack();
            throw $exception;
        }
    }

    public function updateCalendarObject($calendarId, $objectUri, $calendarData)
    {
        $this->guard->calendar($this->uri($calendarId), $calendarData);
        $collection = $this->collection($calendarId);
        $this->begin($calendarId);
        try {
            $result = parent::updateCalendarObject($calendarId, $objectUri, $calendarData);
            $this->afterObjectWrite($calendarId, $objectUri);
            $this->append($collection, $this->objectUid($calendarId, $objectUri), 'updated', $calendarId);
            $this->pdo->commit();
            return $result;
        } catch (\Throwable $exception) {
            $this->rollBack();
            throw $exception;
        }
    }

    public function deleteCalendarObject($calendarId, $objectUri): void
    {
        $collection = $this->collection($calendarId);
        $this->begin($calendarId);
        try {
            // The row is gone after the parent write, so read the UID before it.
            $uid = $this->objectUid($calendarId, $objectUri);
            parent::deleteCalendarObject($calendarId, $objectUri);
            $this->afterObjectWrite($calendarId, $objectUri);
            $this->append($collection, $uid, 'deleted', $calendarId);
            $this->pdo->commit();
        } catch (\Throwable $exception) {
            $this->rollBack();
            throw $exception;
        }
    }

    /**
     * Test seam: runs after the object write and before the outbox insert, inside
     * the transaction. Overridden only by a subclass under tests/ so a test can
     * kill the process and prove both writes are all-or-nothing. The override
     * receives the SabreDAV calendar id pair and the object URI so it can read,
     * on the same connection, what the open transaction has written so far.
     *
     * @param array{0: mixed, 1: mixed} $calendarId
     */
    protected function afterObjectWrite(array $calendarId, string $objectUri): void
    {
    }

    /**
     * Opens the transaction and locks the calendar row, serializing writers so
     * two concurrent changes cannot record the same sync token (E03-R10).
     *
     * @param array{0: mixed, 1: mixed} $calendarId
     */
    private function begin(array $calendarId): void
    {
        if ($this->pdo->inTransaction()) {
            throw new \RuntimeException('CalDAV object writes must not nest transactions');
        }
        $this->pdo->beginTransaction();
        $query = $this->pdo->prepare('SELECT synctoken FROM ' . $this->calendarTableName . ' WHERE id = ? FOR UPDATE');
        $query->execute([$calendarId[0]]);
        if ($query->fetchColumn() === false) {
            $this->rollBack();
            throw new \RuntimeException('Missing SabreDAV calendar row');
        }
    }

    /**
     * Appends the outbox row, in the write's transaction.
     *
     * sync_token is what sync-collection reports for this change: SabreDAV's own
     * calendarchanges row holds the pre-increment value N, while the collection
     * reports N + 1, which is calendars.synctoken after the parent's increment.
     * E05-R08 and E07 hand that number to clients as "changed up to".
     *
     * @param array{0: mixed, 1: mixed} $calendarId
     */
    private function append(string $collection, string $uid, string $changeType, array $calendarId): void
    {
        $query = $this->pdo->prepare('SELECT synctoken FROM ' . $this->calendarTableName . ' WHERE id = ?');
        $query->execute([$calendarId[0]]);
        $token = $query->fetchColumn();
        if (!is_int($token) && !(is_string($token) && ctype_digit($token))) {
            throw new \RuntimeException('Missing SabreDAV sync token');
        }
        $insert = $this->pdo->prepare('INSERT INTO public.caldav_changes (calendar_id, sync_token, uid, change_type) VALUES (?, ?, ?, ?)');
        $insert->execute([$collection, (int) $token, $uid, $changeType]);
    }

    /**
     * The collection UUID, i.e. public.calendars.id, that an object write would
     * land in. A collection without that row cannot take objects: its outbox row
     * would violate the foreign key, so refuse it instead of answering 500.
     *
     * @param array{0: mixed, 1: mixed} $calendarId
     */
    private function collection(array $calendarId): string
    {
        $query = $this->pdo->prepare('SELECT i.uri FROM ' . $this->calendarInstancesTableName . ' i JOIN public.calendars c ON c.id::text = lower(i.uri) WHERE i.id = ? AND i.calendarid = ?');
        $query->execute([$calendarId[1], $calendarId[0]]);
        $uri = $query->fetchColumn();
        if (!is_string($uri) || preg_match('/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i', $uri) !== 1) {
            throw new UnmappedCollection();
        }
        return $uri;
    }

    /** @param array{0: mixed, 1: mixed} $calendarId */
    private function objectUid(array $calendarId, string $objectUri): string
    {
        $query = $this->pdo->prepare('SELECT uid FROM ' . $this->calendarObjectTableName . ' WHERE calendarid = ? AND uri = ?');
        $query->execute([$calendarId[0], $objectUri]);
        $uid = $query->fetchColumn();
        if (!is_string($uid) || $uid === '') {
            throw new \RuntimeException('Missing CalDAV object UID');
        }
        return $uid;
    }

    private function rollBack(): void
    {
        if ($this->pdo->inTransaction()) {
            $this->pdo->rollBack();
        }
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
