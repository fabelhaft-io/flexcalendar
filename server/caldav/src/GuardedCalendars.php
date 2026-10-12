<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\DAV\Exception\Forbidden;
use Sabre\DAV\PropPatch;

class GuardedCalendars extends \Sabre\CalDAV\Backend\PDO
{
    public function __construct(\PDO $pdo, private readonly WriteGuard $guard, private readonly string $principal)
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

    /**
     * E03-R08 — the home is the membership.
     *
     * One entry per `public.calendar_members` row of the acting user, at
     * `/calendars/<users.id>/<calendars.id>/`, read from the database on every
     * request with no cache. The entry keeps SabreDAV's shape (it comes from the
     * parent, which owns the property mapping and the sync-token fields) and adds
     * the membership role the ACL nodes are built from. A calendar whose
     * collection was not created yet, or one whose `sabredav.calendarinstances`
     * row is missing, is simply not listed. A database error propagates: the
     * request fails with a 500 and nothing is written, never with an empty list.
     *
     * @param string $principalUri
     *
     * @return list<array<string, mixed>>
     */
    public function getCalendarsForUser($principalUri)
    {
        if ($principalUri !== $this->principalUri()) {
            return [];
        }
        $calendars = [];
        foreach ($this->memberships() as $ownerPrincipal => $entries) {
            /** @var list<array<string, mixed>> $owned */
            $owned = parent::getCalendarsForUser($ownerPrincipal);
            foreach ($owned as $calendar) {
                $uri = is_string($calendar['uri'] ?? null) ? strtolower($calendar['uri']) : '';
                if (!isset($entries[$uri])) {
                    continue;
                }
                $calendar['principaluri'] = $principalUri;
                $calendar[Access::ROLE] = $entries[$uri];
                $calendars[] = $calendar;
            }
        }

        return $calendars;
    }

    /** @param array<string, mixed> $properties */
    public function createCalendar($principalUri, $calendarUri, array $properties)
    {
        // Only the acting user's own home can be reached through the tree, and
        // SabreDAV's principal backend only exposes that one principal, so this
        // is defence in depth rather than a control a client can reach.
        if ($principalUri !== $this->principalUri()) {
            throw new Forbidden('Calendars are created in the acting principal own home');
        }
        $this->guard->properties($calendarUri, $properties);
        return parent::createCalendar($principalUri, $calendarUri, $properties);
    }

    public function updateCalendar($calendarId, PropPatch $propPatch): void
    {
        $this->requireProperties($calendarId);
        $this->guard->properties($this->uri($calendarId), $propPatch->getMutations());
        parent::updateCalendar($calendarId, $propPatch);
    }

    /**
     * Deleting the collection is the owner's privilege. The DAVACL plugin only
     * checks `{DAV:}unbind` on the parent home here, which belongs to the acting
     * user, so the membership role decides.
     *
     * @param mixed $calendarId
     */
    public function deleteCalendar($calendarId): void
    {
        $this->requireOwner($calendarId);
        parent::deleteCalendar($calendarId);
    }

    public function createCalendarObject($calendarId, $objectUri, $calendarData)
    {
        $collection = $this->collection($calendarId);
        $this->requireObjectWrite($calendarId);
        // A `PUT` to a name the collection does not hold, a `COPY` in, and the
        // copy half of a cross-collection `MOVE`: all three arrive here, and
        // E03-R11 needs the name SabreDAV is about to store under.
        $this->guard->createObject($this->uri($calendarId), $objectUri, $calendarData);
        $this->begin($calendarId);
        try {
            $result = parent::createCalendarObject($calendarId, $objectUri, $calendarData);
            $this->afterObjectWrite($calendarId, $objectUri);
            $this->append($collection, $this->objectUid($calendarId, $objectUri), 'created', $calendarId);
            $this->pdo->commit();
            return $result;
        } catch (\Throwable $exception) {
            $this->rollBack();
            // E03-R12: a series `sabre/vobject` cannot walk within the bound is
            // RFC 4791's `403` `CALDAV:max-instances`, on every calendar mode,
            // not a `500`. The walk runs before any row is written, and the
            // rollback above covers the transaction, so the refusal stores
            // nothing: no object row, no `calendarchanges` row, no outbox row.
            throw MaxInstances::translate($exception);
        }
    }

    public function updateCalendarObject($calendarId, $objectUri, $calendarData)
    {
        $collection = $this->collection($calendarId);
        $this->requireObjectWrite($calendarId);
        // E03-R11: the stored `UID` is what an update must keep, read before the
        // guard so a rewrite that changes it is refused before anything is
        // staged. Read in every mode, exactly as `deleteCalendarObject` and the
        // outbox already do.
        $this->guard->updateObject($this->uri($calendarId), $calendarData, $this->objectUid($calendarId, $objectUri));
        $this->begin($calendarId);
        try {
            $result = parent::updateCalendarObject($calendarId, $objectUri, $calendarData);
            $this->afterObjectWrite($calendarId, $objectUri);
            $this->append($collection, $this->objectUid($calendarId, $objectUri), 'updated', $calendarId);
            $this->pdo->commit();
            return $result;
        } catch (\Throwable $exception) {
            $this->rollBack();
            // The same bound on a rewrite: the object is left as it was.
            throw MaxInstances::translate($exception);
        }
    }

    public function deleteCalendarObject($calendarId, $objectUri): void
    {
        $collection = $this->collection($calendarId);
        $this->requireObjectWrite($calendarId);
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

    private function principalUri(): string
    {
        return 'principals/' . $this->principal;
    }

    /**
     * The acting user's memberships, grouped by the principal that owns the
     * SabreDAV instance: calendar id (lower-cased UUID) => role. The instance is
     * the owner's (`access = 1`); Phase 1 has exactly one instance per calendar,
     * and picking the owner's keeps the entry shape identical to the owner's own.
     *
     * @return array<string, array<string, string>>
     */
    private function memberships(): array
    {
        $query = $this->pdo->prepare(
            'SELECT lower(c.id::text) AS calendar_id, m.role, i.principaluri'
            . ' FROM public.calendar_members m'
            . ' JOIN public.calendars c ON c.id = m.calendar_id'
            . ' JOIN ' . $this->calendarInstancesTableName . ' i ON lower(i.uri) = lower(c.id::text) AND i.access = 1'
            . ' WHERE m.user_id = ?'
        );
        $query->execute([$this->principal]);
        $memberships = [];
        foreach ($query->fetchAll(\PDO::FETCH_ASSOC) as $row) {
            $calendar = $row['calendar_id'] ?? null;
            $role = $row['role'] ?? null;
            $owner = $row['principaluri'] ?? null;
            if (!is_string($calendar) || !is_string($role) || !is_string($owner)) {
                continue;
            }
            $memberships[$owner][$calendar] = $role;
        }

        return $memberships;
    }

    /**
     * The acting user's role in the calendar a SabreDAV id pair points at, or
     * null when the collection has no `public.calendars` row or the user has no
     * membership in it. Read per call; nothing is cached.
     *
     * @param array{0: mixed, 1: mixed} $calendarId
     */
    private function role(array $calendarId): ?string
    {
        $query = $this->pdo->prepare(
            'SELECT m.role FROM ' . $this->calendarInstancesTableName . ' i'
            . ' JOIN public.calendars c ON lower(c.id::text) = lower(i.uri)'
            . ' JOIN public.calendar_members m ON m.calendar_id = c.id'
            . ' WHERE i.calendarid = ? AND i.id = ? AND m.user_id = ?'
        );
        $query->execute([$calendarId[0], $calendarId[1], $this->principal]);
        $role = $query->fetchColumn();

        return is_string($role) ? $role : null;
    }

    /** @param array{0: mixed, 1: mixed} $calendarId */
    private function requireObjectWrite(array $calendarId): void
    {
        $role = $this->role($calendarId);
        if ($role === null || !Access::canWriteObjects($role)) {
            throw new Forbidden('The acting principal may not write in this calendar');
        }
    }

    /** @param array{0: mixed, 1: mixed} $calendarId */
    private function requireProperties(array $calendarId): void
    {
        $role = $this->role($calendarId);
        if ($role === null || !Access::canWriteProperties($role)) {
            throw new Forbidden('The acting principal may not change this calendar');
        }
    }

    /**
     * @param array{0: mixed, 1: mixed} $calendarId
     */
    private function requireOwner(array $calendarId): void
    {
        $role = $this->role($calendarId);
        if ($role === null || !Access::canDeleteCollection($role)) {
            throw new Forbidden('The acting principal may not delete this calendar');
        }
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
