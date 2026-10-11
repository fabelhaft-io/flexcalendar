<?php

declare(strict_types=1);

namespace Calflex\Tests\Integration;

use Calflex\Access;
use Calflex\Database;
use Calflex\GuardedCalendars;
use Calflex\PrivateSkeletonOnly;
use Calflex\Tests\GuardCases;
use Calflex\UnmappedCollection;
use Calflex\WriteGuard;
use PHPUnit\Framework\TestCase;
use Sabre\DAV\Exception\Forbidden;
use Sabre\DAV\PropPatch;

/**
 * E03-R08 — the backend half of the access check, called directly.
 *
 * Over HTTP the node ACLs answer first, so a request never reaches these
 * methods with a role that may not use them; a path that skipped the ACL plugin
 * would. This file builds `GuardedCalendars` for a viewer, an editor, the owner
 * and a non-member — the same calendar, the same `public.calendar_members` rows
 * the API writes, changed directly — and calls every write method, with a body
 * the E03-R09 guard accepts and with one it rejects. The refusal must be the
 * authorization one (`Forbidden`, exactly, never `PrivateSkeletonOnly` or
 * `UnmappedCollection`), it must happen before the guard and before the
 * E03-R10 transaction, and it must leave `sabredav.calendarobjects`,
 * `sabredav.calendarchanges` and `public.caldav_changes` untouched.
 *
 * The collection is created through the backend, which is how E05-R03 will
 * create it beside the `public.calendars` and `calendar_members` rows.
 */
final class BackendAccessTest extends TestCase
{
    private \PDO $api;
    private \PDO $dav;

    private string $owner;
    private string $editor;
    private string $viewer;
    private string $stranger;
    private string $calendar;
    /** @var array{0: int, 1: int} the SabreDAV [calendarid, instanceid] pair */
    private array $ids = [0, 0];
    /** @var list<array{0: int, 1: int}> */
    private array $instances = [];
    /** @var list<string> the public.calendars rows of this test */
    private array $calendars = [];

    private static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 15) | 64);
        $bytes[8] = chr((ord($bytes[8]) & 63) | 128);
        $hex = bin2hex($bytes);
        return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20);
    }

    protected function setUp(): void
    {
        $this->api = Database::connect(getenv('CALFLEX_API_TEST_DATABASE_URL') ?: '');
        $this->dav = Database::connect(getenv('CALFLEX_DATABASE_URL') ?: '');
        self::assertSame('calflex_api', $this->api->query('SELECT current_user')->fetchColumn());
        self::assertSame('calflex_caldav', $this->dav->query('SELECT current_user')->fetchColumn());
        $this->owner = self::uuid();
        $this->editor = self::uuid();
        $this->viewer = self::uuid();
        $this->stranger = self::uuid();
        $this->calendar = self::uuid();
        foreach ([$this->owner, $this->editor, $this->viewer, $this->stranger] as $id) {
            $query = $this->api->prepare('INSERT INTO public.users (id, idp_subject, handle, email) VALUES (?, ?, ?, ?)');
            $query->execute([$id, $id, $id, $id . '@example.invalid']);
        }
        // The API's rows first, exactly as E05-R03 will write them, then the
        // collection. The calendar starts without a display name, so the owner's
        // PROPPATCH has something to change.
        $this->calendars[] = $this->calendar;
        $this->register($this->calendar);
        $this->member($this->calendar, $this->owner, Access::OWNER);
        $this->member($this->calendar, $this->editor, Access::EDITOR);
        $this->member($this->calendar, $this->viewer, Access::VIEWER);
        $this->ids = $this->collect($this->calendar, $this->owner);
    }

    protected function tearDown(): void
    {
        if (!isset($this->owner)) {
            return;
        }
        foreach ($this->instances as $pair) {
            $this->execute('DELETE FROM sabredav.calendarobjects WHERE calendarid = ?', [$pair[0]]);
            $this->execute('DELETE FROM sabredav.calendarchanges WHERE calendarid = ?', [$pair[0]]);
            $this->execute('DELETE FROM sabredav.calendarinstances WHERE calendarid = ?', [$pair[0]]);
            $this->execute('DELETE FROM sabredav.calendars WHERE id = ?', [$pair[0]]);
        }
        $calendarIds = '{' . implode(',', $this->calendars) . '}';
        $query = $this->api->prepare('DELETE FROM public.calendar_members WHERE calendar_id = ANY(?)');
        $query->execute([$calendarIds]);
        $query = $this->api->prepare('DELETE FROM public.calendars WHERE id = ANY(?)');
        $query->execute([$calendarIds]);
        $query = $this->api->prepare('DELETE FROM public.users WHERE id = ANY(?)');
        $query->execute(['{' . implode(',', [$this->owner, $this->editor, $this->viewer, $this->stranger]) . '}']);
    }

    /**
     * The home is the membership, read per call: one entry per row, at that
     * member's own href, and a row that goes away takes the calendar with it.
     */
    public function testTheHomeIsTheMembershipRows(): void
    {
        foreach ([Access::OWNER => $this->owner, Access::EDITOR => $this->editor, Access::VIEWER => $this->viewer] as $role => $actor) {
            $calendars = $this->backend($actor)->getCalendarsForUser('principals/' . $actor);
            self::assertCount(1, $calendars);
            self::assertSame($this->calendar, $calendars[0]['uri']);
            self::assertSame('principals/' . $actor, $calendars[0]['principaluri'], 'The entry is the acting user own href');
            self::assertSame($role, $calendars[0][Access::ROLE]);
        }
        self::assertSame([], $this->backend($this->stranger)->getCalendarsForUser('principals/' . $this->stranger), 'A non-member has no home entry');
        self::assertSame([], $this->backend($this->owner)->getCalendarsForUser('principals/' . $this->viewer), 'Another principal home is empty, never the actor own');

        $this->unmember($this->calendar, $this->viewer);
        self::assertSame([], $this->backend($this->viewer)->getCalendarsForUser('principals/' . $this->viewer));
        self::assertCount(1, $this->backend($this->owner)->getCalendarsForUser('principals/' . $this->owner), 'A removed member does not remove the owner home entry');
    }

    public function testACreateFollowsTheMembershipRole(): void
    {
        $uri = self::uuid() . '.ics';
        foreach ([$this->viewer, $this->stranger] as $actor) {
            $this->forbidden(fn () => $this->backend($actor)->createCalendarObject($this->pair(), $uri, GuardCases::skeleton()));
            self::assertSame(0, $this->objects(), 'A refused create must store nothing');
            self::assertSame(0, $this->changes(), 'A refused create must record no Sabre change');
            self::assertSame(0, $this->outbox(), 'A refused create must not reach the outbox');
        }

        self::assertIsString($this->backend($this->editor)->createCalendarObject($this->ids, $uri, GuardCases::skeleton()));
        self::assertSame(1, $this->objects());
        self::assertSame(1, $this->changes());
        self::assertSame(1, $this->outbox());

        self::assertIsString($this->backend($this->owner)->createCalendarObject($this->ids, self::uuid() . '.ics', GuardCases::skeleton()));
        self::assertSame(2, $this->objects());
    }

    public function testAnUpdateFollowsTheMembershipRole(): void
    {
        $uri = self::uuid() . '.ics';
        $this->backend($this->owner)->createCalendarObject($this->ids, $uri, GuardCases::skeleton());
        $changes = $this->changes();
        $etag = $this->etag($uri);

        foreach ([$this->viewer, $this->stranger] as $actor) {
            $this->forbidden(fn () => $this->backend($actor)->updateCalendarObject($this->pair(), $uri, self::at('120000')));
            self::assertSame($etag, $this->etag($uri), 'A refused update must leave the object alone');
            self::assertSame($changes, $this->changes(), 'A refused update must record no Sabre change');
            self::assertSame(1, $this->outbox(), 'A refused update must not reach the outbox');
        }

        self::assertIsString($this->backend($this->editor)->updateCalendarObject($this->ids, $uri, self::at('120000')));
        self::assertNotSame($etag, $this->etag($uri));
        self::assertSame($changes + 1, $this->changes());
        self::assertSame(2, $this->outbox());
    }

    public function testADeleteFollowsTheMembershipRole(): void
    {
        $uri = self::uuid() . '.ics';
        $this->backend($this->owner)->createCalendarObject($this->ids, $uri, GuardCases::skeleton());

        foreach ([$this->viewer, $this->stranger] as $actor) {
            $this->forbidden(fn () => $this->backend($actor)->deleteCalendarObject($this->pair(), $uri));
            self::assertSame(1, $this->objects(), 'A refused delete must leave the object stored');
        }

        $this->backend($this->editor)->deleteCalendarObject($this->ids, $uri);
        self::assertSame(0, $this->objects());
        self::assertSame(['created', 'deleted'], $this->outboxTypes(), 'The delete is recorded once, after the create');
    }

    /**
     * Authorization first: a body the E03-R09 guard rejects is still a plain
     * `Forbidden` for a role that may not write, and the guard's precondition
     * only for an editor or the owner. Nothing is stored either way.
     */
    public function testTheRoleIsCheckedBeforeTheWriteGuard(): void
    {
        $rejected = GuardCases::rejected()['SUMMARY'][0];
        $uri = self::uuid() . '.ics';
        foreach ([$this->viewer, $this->stranger] as $actor) {
            $this->forbidden(fn () => $this->backend($actor)->createCalendarObject($this->pair(), $uri, $rejected));
        }
        self::assertSame(0, $this->objects());
        self::assertSame(0, $this->changes());
        self::assertSame(0, $this->outbox());

        $this->backend($this->owner)->createCalendarObject($this->ids, $uri, GuardCases::skeleton());
        $etag = $this->etag($uri);
        foreach ([$this->viewer, $this->stranger] as $actor) {
            $this->forbidden(fn () => $this->backend($actor)->updateCalendarObject($this->pair(), $uri, $rejected));
            self::assertSame($etag, $this->etag($uri));
        }
        self::assertSame(1, $this->changes());
        self::assertSame(1, $this->outbox());

        $this->skeletonOnly(fn () => $this->backend($this->editor)->createCalendarObject($this->pair(), self::uuid() . '.ics', $rejected));
        $this->skeletonOnly(fn () => $this->backend($this->editor)->updateCalendarObject($this->pair(), $uri, $rejected));
        $this->skeletonOnly(fn () => $this->backend($this->owner)->updateCalendarObject($this->pair(), $uri, $rejected));
        self::assertSame(1, $this->objects(), 'A refused body must store nothing');
        self::assertSame(1, $this->changes());
        self::assertSame(1, $this->outbox());
    }

    public function testOnlyTheOwnerChangesTheCollectionProperties(): void
    {
        self::assertNull($this->displayName());
        foreach ([$this->viewer, $this->editor, $this->stranger] as $actor) {
            $patch = new PropPatch(['{DAV:}displayname' => 'Private calendar']);
            $this->forbidden(function () use ($actor, $patch): void {
                $this->backend($actor)->updateCalendar($this->ids, $patch);
            });
            self::assertNull($this->displayName(), 'A refused PROPPATCH must write nothing');
        }

        $patch = new PropPatch(['{DAV:}displayname' => 'Private calendar']);
        $this->backend($this->owner)->updateCalendar($this->ids, $patch);
        self::assertTrue($patch->commit(), 'The owner PROPPATCH must be handled');
        self::assertSame('Private calendar', $this->displayName());
    }

    public function testOnlyTheOwnerDeletesTheCollection(): void
    {
        foreach ([$this->viewer, $this->editor, $this->stranger] as $actor) {
            $this->forbidden(fn () => $this->backend($actor)->deleteCalendar($this->pair()));
            self::assertSame(1, $this->instances(), 'A refused delete must leave the collection in place');
        }

        $this->backend($this->owner)->deleteCalendar($this->ids);
        self::assertSame(0, $this->instances());
    }

    public function testACalendarIsCreatedOnlyInTheActingPrincipalOwnHome(): void
    {
        $uri = self::uuid();
        $this->forbidden(fn () => $this->backend($this->owner)->createCalendar('principals/' . $this->viewer, $uri, []));
        self::assertSame(0, $this->instancesOf($uri), 'A refused create must store nothing');
    }

    /**
     * A collection without a `public.calendars` row is in no home and cannot
     * take objects: the outbox row's foreign key could not be satisfied, so the
     * write is refused before anything is stored. This is the backstop for a
     * backend call that reaches such a collection; over HTTP it is already a 404
     * (E03-R10's own suite).
     */
    public function testACollectionWithoutARegisteredCalendarIsRefusedBeforeAnyWrite(): void
    {
        $uri = self::uuid();
        $unregistered = $this->collect($uri, $this->owner);
        self::assertCount(1, $this->backend($this->owner)->getCalendarsForUser('principals/' . $this->owner), 'An unregistered collection is in no home');

        $object = self::uuid() . '.ics';
        $this->unmapped(fn () => $this->backend($this->owner)->createCalendarObject($unregistered, $object, GuardCases::skeleton()));
        $this->unmapped(fn () => $this->backend($this->owner)->updateCalendarObject($unregistered, $object, GuardCases::skeleton()));
        $this->unmapped(fn () => $this->backend($this->owner)->deleteCalendarObject($unregistered, $object));
        self::assertSame(0, $this->objectsOf($unregistered), 'A refused write must store nothing');
        self::assertSame(0, $this->changesOf($unregistered));
        self::assertSame(1, $this->syncTokenOf($unregistered), 'A refused write must not bump the sync token');
    }

    private function backend(string $actor): GuardedCalendars
    {
        return new GuardedCalendars($this->dav, WriteGuard::fromPdo($this->dav), $actor);
    }

    /** The `public.calendars` row the API creates before a collection exists. */
    private function register(string $calendar): void
    {
        $query = $this->api->prepare("INSERT INTO public.calendars (id, owner_id, mode, caldav_href, meta_envelope, meta_epoch) VALUES (?, ?, 'private', ?, decode('00', 'hex'), 1)");
        $query->execute([$calendar, $this->owner, '/calendars/' . $this->owner . '/' . $calendar . '/']);
    }

    private function member(string $calendar, string $user, string $role): void
    {
        $query = $this->api->prepare('INSERT INTO public.calendar_members (calendar_id, user_id, role) VALUES (?, ?, ?)');
        $query->execute([$calendar, $user, $role]);
    }

    private function unmember(string $calendar, string $user): void
    {
        $query = $this->api->prepare('DELETE FROM public.calendar_members WHERE calendar_id = ? AND user_id = ?');
        $query->execute([$calendar, $user]);
        self::assertSame(1, $query->rowCount());
    }

    /**
     * Creates the SabreDAV collection through the backend, as E05-R03 will, and
     * returns the id pair its methods take.
     *
     * @return array{0: int, 1: int}
     */
    private function collect(string $calendar, string $actor): array
    {
        // SabreDAV's own `PDO::createCalendar` is documented as returning a
        // string but actually returns the [calendarid, instanceid] pair. Type
        // the value as `mixed`, so the check below is a live narrowing of the
        // real return rather than a comparison against the wrong declaration.
        /** @var mixed $ids */
        $ids = $this->backend($actor)->createCalendar('principals/' . $actor, $calendar, []);
        if (!is_array($ids) || !isset($ids[0], $ids[1])) {
            throw new \RuntimeException('createCalendar did not return the SabreDAV id pair');
        }
        $pair = [(int) $ids[0], (int) $ids[1]];
        $this->instances[] = $pair;

        return $pair;
    }

    /** @param \Closure(): mixed $call */
    private function forbidden(\Closure $call): void
    {
        try {
            $call();
        } catch (Forbidden $exception) {
            // Exactly the authorization refusal: neither the guard's nor the
            // unregistered-collection one may stand in for it.
            self::assertSame(Forbidden::class, $exception::class);

            return;
        }
        self::fail('The write must be refused with Forbidden');
    }

    /** @param \Closure(): mixed $call */
    private function skeletonOnly(\Closure $call): void
    {
        try {
            $call();
        } catch (PrivateSkeletonOnly $exception) {
            self::assertSame(403, $exception->getHTTPCode());

            return;
        }
        self::fail('The write must be refused with the guard precondition');
    }

    /** @param \Closure(): mixed $call */
    private function unmapped(\Closure $call): void
    {
        try {
            $call();
        } catch (UnmappedCollection $exception) {
            self::assertSame(403, $exception->getHTTPCode());

            return;
        }
        self::fail('The write must be refused with the unregistered-collection precondition');
    }

    /** @return array{0: int, 1: int} */
    private function pair(): array
    {
        return $this->ids;
    }

    /** @param array{0: int, 1: int} $pair */
    private function objectsOf(array $pair): int
    {
        return $this->scalar('SELECT count(*) FROM sabredav.calendarobjects WHERE calendarid = ?', [$pair[0]]);
    }

    /** @param array{0: int, 1: int} $pair */
    private function changesOf(array $pair): int
    {
        return $this->scalar('SELECT count(*) FROM sabredav.calendarchanges WHERE calendarid = ?', [$pair[0]]);
    }

    /** @param array{0: int, 1: int} $pair */
    private function syncTokenOf(array $pair): int
    {
        return $this->scalar('SELECT synctoken FROM sabredav.calendars WHERE id = ?', [$pair[0]]);
    }

    private function objects(): int
    {
        return $this->objectsOf($this->ids);
    }

    private function changes(): int
    {
        return $this->changesOf($this->ids);
    }

    private function outbox(): int
    {
        return $this->scalar('SELECT count(*) FROM public.caldav_changes WHERE calendar_id = ?', [$this->calendar]);
    }

    /** @return list<string> */
    private function outboxTypes(): array
    {
        $query = $this->dav->prepare('SELECT change_type FROM public.caldav_changes WHERE calendar_id = ? ORDER BY sync_token');
        $query->execute([$this->calendar]);
        $types = [];
        foreach ($query->fetchAll(\PDO::FETCH_ASSOC) as $row) {
            $types[] = (string) $row['change_type'];
        }

        return $types;
    }

    private function etag(string $uri): ?string
    {
        $query = $this->dav->prepare('SELECT etag FROM sabredav.calendarobjects WHERE calendarid = ? AND uri = ?');
        $query->execute([$this->ids[0], $uri]);
        $etag = $query->fetchColumn();

        return is_string($etag) ? $etag : null;
    }

    private function displayName(): ?string
    {
        $query = $this->dav->prepare('SELECT displayname FROM sabredav.calendarinstances WHERE id = ?');
        $query->execute([$this->ids[1]]);
        $name = $query->fetchColumn();

        return is_string($name) ? $name : null;
    }

    private function instances(): int
    {
        $query = $this->dav->prepare('SELECT count(*) FROM sabredav.calendarinstances WHERE calendarid = ?');
        $query->execute([$this->ids[0]]);

        return (int) $query->fetchColumn();
    }

    private function instancesOf(string $uri): int
    {
        $query = $this->dav->prepare('SELECT count(*) FROM sabredav.calendarinstances WHERE uri = ?');
        $query->execute([$uri]);

        return (int) $query->fetchColumn();
    }

    /** @param list<int|string> $parameters */
    private function scalar(string $sql, array $parameters): int
    {
        $query = $this->dav->prepare($sql);
        $query->execute($parameters);

        return (int) $query->fetchColumn();
    }

    /** @param list<int|string> $parameters */
    private function execute(string $sql, array $parameters): void
    {
        $query = $this->dav->prepare($sql);
        $query->execute($parameters);
    }

    /** The valid skeleton with one property value moved, so the etag changes. */
    private static function at(string $time): string
    {
        return str_replace('DTSTART:20261012T100000Z', 'DTSTART:20261012T' . $time . 'Z', GuardCases::skeleton());
    }
}
