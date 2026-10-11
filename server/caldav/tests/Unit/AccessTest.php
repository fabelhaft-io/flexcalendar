<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Access;
use Calflex\MembershipCalendar;
use Calflex\MembershipCalendarHome;
use PHPUnit\Framework\TestCase;

/**
 * E03-R08 — the role → privilege mapping and the two nodes built from it.
 *
 * The mapping is pure, so it is pinned here exactly; the integration suite then
 * proves that SabreDAV enforces and advertises what these privileges say.
 */
final class AccessTest extends TestCase
{
    public function testCollectionPrivilegesAreExactlyTheRequirementTable(): void
    {
        self::assertSame(['{DAV:}read'], Access::collection('viewer'));
        self::assertSame(['{DAV:}read', '{DAV:}write-content', '{DAV:}bind', '{DAV:}unbind'], Access::collection('editor'));
        self::assertSame(['{DAV:}read', '{DAV:}write-content', '{DAV:}bind', '{DAV:}unbind', '{DAV:}write-properties'], Access::collection('owner'));
        foreach (['viewer', 'editor', 'owner'] as $role) {
            // {DAV:}write aggregates write-properties, write-content, bind, unbind
            // and write-acl: too much for an editor and a way to change ACLs for
            // everyone, which E03-R08 forbids.
            self::assertNotContains('{DAV:}write', Access::collection($role));
            self::assertNotContains('{DAV:}write-acl', Access::collection($role));
        }
    }

    public function testObjectPrivilegesFollowTheRole(): void
    {
        self::assertSame(['{DAV:}read'], Access::objects('viewer'));
        self::assertSame(['{DAV:}read', '{DAV:}write'], Access::objects('editor'));
        self::assertSame(['{DAV:}read', '{DAV:}write'], Access::objects('owner'));
    }

    public function testUnknownRoleIsRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        Access::collection('admin');
    }

    public function testOnlyTheOwnerGetsTheOwnerOnlyPrivileges(): void
    {
        self::assertFalse(Access::canWriteObjects('viewer'));
        self::assertTrue(Access::canWriteObjects('editor'));
        self::assertTrue(Access::canWriteObjects('owner'));
        foreach (['viewer', 'editor'] as $role) {
            self::assertFalse(Access::canWriteProperties($role));
            self::assertFalse(Access::canDeleteCollection($role));
        }
        self::assertTrue(Access::canWriteProperties('owner'));
        self::assertTrue(Access::canDeleteCollection('owner'));
    }

    /**
     * A calendar node without a role is a bug, not a calendar with no
     * privileges: the backend stamps every entry it lists.
     */
    public function testCalendarWithoutAMembershipRoleIsRefused(): void
    {
        self::assertSame('editor', Access::role(['calflex-role' => 'editor']));
        foreach ([[], ['calflex-role' => 'admin'], ['calflex-role' => 1], ['calflex-role' => null]] as $calendarInfo) {
            try {
                Access::role($calendarInfo);
                self::fail('A calendar without a membership role must be refused');
            } catch (\RuntimeException $exception) {
                self::assertSame('Calendar collection without a membership role', $exception->getMessage());
            }
        }
    }

    public function testCalendarAclNamesTheActingPrincipalOnly(): void
    {
        $backend = self::backend();
        $viewer = new MembershipCalendar($backend, ['uri' => 'c', 'principaluri' => 'principals/actor', Access::ROLE => 'viewer'], 'viewer');
        self::assertSame([['privilege' => '{DAV:}read', 'principal' => 'principals/actor', 'protected' => true]], $viewer->getACL());
        self::assertSame([['privilege' => '{DAV:}read', 'principal' => 'principals/actor', 'protected' => true]], $viewer->getChildACL());

        $owner = new MembershipCalendar($backend, ['uri' => 'c', 'principaluri' => 'principals/actor', Access::ROLE => 'owner'], 'owner');
        $privileges = array_column($owner->getACL(), 'privilege');
        self::assertContains('{DAV:}write-properties', $privileges);
        self::assertNotContains('{DAV:}write', $privileges);
        foreach (array_merge($owner->getACL(), $owner->getChildACL()) as $ace) {
            self::assertSame('principals/actor', $ace['principal']);
        }
    }

    public function testHomeBuildsMembershipNodesForTheListedCalendars(): void
    {
        $backend = self::backend([
            ['uri' => 'first', 'principaluri' => 'principals/actor', Access::ROLE => 'owner'],
            ['uri' => 'second', 'principaluri' => 'principals/actor', Access::ROLE => 'viewer'],
        ]);
        $home = new MembershipCalendarHome($backend, ['uri' => 'principals/actor']);

        $children = $home->getChildren();
        self::assertCount(2, $children);
        self::assertInstanceOf(MembershipCalendar::class, $children[0]);
        self::assertSame('first', $children[0]->getName());
        self::assertSame('second', $home->getChild('second')->getName());

        $this->expectException(\Sabre\DAV\Exception\NotFound::class);
        $home->getChild('absent');
    }

    /**
     * @param list<array<string, mixed>> $calendars
     */
    private static function backend(array $calendars = []): \Sabre\CalDAV\Backend\BackendInterface
    {
        return new class ($calendars) implements \Sabre\CalDAV\Backend\BackendInterface {
            /** @param list<array<string, mixed>> $calendars */
            public function __construct(private readonly array $calendars)
            {
            }

            /** @return list<array<string, mixed>> */
            public function getCalendarsForUser($principalUri): array
            {
                return $this->calendars;
            }

            /** @param array<string, mixed> $properties */
            public function createCalendar($principalUri, $calendarUri, array $properties): string
            {
                return '0';
            }

            /** @param mixed $calendarId */
            public function updateCalendar($calendarId, \Sabre\DAV\PropPatch $propPatch): void
            {
            }

            /** @param mixed $calendarId */
            public function deleteCalendar($calendarId): void
            {
            }

            /** @param mixed $calendarId
             * @return list<array<string, mixed>>
             */
            public function getCalendarObjects($calendarId): array
            {
                return [];
            }

            /** @param mixed $calendarId
             * @return array<string, mixed>|null
             */
            public function getCalendarObject($calendarId, $objectUri): ?array
            {
                return null;
            }

            /**
             * @param mixed        $calendarId
             * @param list<string> $uris
             *
             * @return list<array<string, mixed>>
             */
            public function getMultipleCalendarObjects($calendarId, array $uris): array
            {
                return [];
            }

            /**
             * @param mixed  $calendarId
             * @param string $objectUri
             * @param string $calendarData
             */
            public function createCalendarObject($calendarId, $objectUri, $calendarData): ?string
            {
                return null;
            }

            /**
             * @param mixed  $calendarId
             * @param string $objectUri
             * @param string $calendarData
             */
            public function updateCalendarObject($calendarId, $objectUri, $calendarData): ?string
            {
                return null;
            }

            /** @param mixed $calendarId */
            public function deleteCalendarObject($calendarId, $objectUri): void
            {
            }

            /** @param mixed              $calendarId
             * @param array<string, mixed> $filters
             *
             * @return list<string>
             */
            public function calendarQuery($calendarId, array $filters): array
            {
                return [];
            }

            /** @return string|null */
            public function getCalendarObjectByUID($principalUri, $uid): ?string
            {
                return null;
            }
        };
    }
}
