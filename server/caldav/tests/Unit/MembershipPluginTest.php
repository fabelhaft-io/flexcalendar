<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Access;
use Calflex\MembershipCalendarHome;
use Calflex\MembershipPlugin;
use PHPUnit\Framework\TestCase;
use Sabre\DAV\Auth\Backend\BackendInterface as AuthBackend;
use Sabre\DAV\SimpleCollection;
use Sabre\DAV\Server;
use Sabre\DAVACL\Exception\NeedPrivileges;
use Sabre\HTTP\Request;
use Sabre\HTTP\RequestInterface;
use Sabre\HTTP\Response;
use Sabre\HTTP\ResponseInterface;

/**
 * E03-R08 — the plugin's own check of the collection node.
 *
 * The DAVACL plugin's `beforeUnbind` only checks `{DAV:}unbind` on the parent
 * *home*, and that home belongs to the acting user, so on its own it would let a
 * viewer delete a calendar they may only read. `MembershipPlugin::beforeUnbind`
 * therefore checks the collection node as well.
 *
 * Over HTTP an editor's `DELETE` of a collection passes that check — an editor
 * holds `{DAV:}unbind` on the collection, it is how it deletes objects — and is
 * then refused by `GuardedCalendars::deleteCalendar`; that half is pinned by
 * `tests/Integration/BackendAccessTest.php`. This file is the other half: the
 * node check itself, against a tree whose home grants the acting principal the
 * same `{DAV:}write` SabreDAV's own home does, so a refusal here can only come
 * from the collection's membership ACL.
 */
final class MembershipPluginTest extends TestCase
{
    private const ACTOR = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    private const CALENDAR = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

    public function testACollectionIsCheckedAgainstTheMembershipRoleBeforeTheParentHome(): void
    {
        foreach (['viewer'] as $role) {
            try {
                self::plugin($role)->beforeUnbind(self::calendarPath());
                self::fail('A ' . $role . ' must not pass the collection unbind check');
            } catch (NeedPrivileges $exception) {
                self::assertSame(403, $exception->getHTTPCode());
            }
        }

        foreach (['editor', 'owner'] as $role) {
            // Neither call may throw: the node check passes, and so does the
            // DAVACL parent check on the home. The editor's delete still ends
            // in a 403, from the backend.
            self::plugin($role)->beforeUnbind(self::calendarPath());
        }
    }

    /**
     * The extra check is the collection's only: for an object the plugin leaves
     * the decision to the DAVACL handler, which checks `{DAV:}unbind` on the
     * calendar above. A viewer therefore does not gain anything here, and an
     * editor still passes.
     */
    public function testAnObjectIsLeftToTheParentCalendarCheck(): void
    {
        $object = self::calendarPath() . '/2f4a6c8e-1b3d-4f5a-9c7e-8d6b4a2f0c1e.ics';
        try {
            self::plugin('viewer')->beforeUnbind($object);
            self::fail('A viewer must not pass the parent calendar unbind check');
        } catch (NeedPrivileges $exception) {
            self::assertSame(403, $exception->getHTTPCode());
        }
        self::plugin('editor')->beforeUnbind($object);
    }

    private static function calendarPath(): string
    {
        return 'calendars/' . self::ACTOR . '/' . self::CALENDAR;
    }

    /**
     * A SabreDAV server whose tree is the E03-R08 one — root, `calendars`, the
     * acting user's home, one membership calendar — with the acting principal
     * authenticated and the plugin installed, so `beforeUnbind` runs the real
     * privilege checks.
     */
    private static function plugin(string $role): MembershipPlugin
    {
        $backend = self::createStub(\Sabre\CalDAV\Backend\BackendInterface::class);
        $backend->method('getCalendarsForUser')->willReturn([[
            'id' => [1, 1],
            'uri' => self::CALENDAR,
            'principaluri' => 'principals/' . self::ACTOR,
            Access::ROLE => $role,
        ]]);
        $home = new MembershipCalendarHome($backend, ['uri' => 'principals/' . self::ACTOR]);
        $root = new SimpleCollection('root', [
            // The principal node the DAVACL group-membership walk expects; a
            // non-IPrincipal node simply has no groups.
            new SimpleCollection('principals', [new SimpleCollection(self::ACTOR)]),
            new SimpleCollection('calendars', [$home]),
        ]);

        $server = new Server($root);
        $server->setBaseUri('/');
        $auth = new \Sabre\DAV\Auth\Plugin(new class ('principals/' . self::ACTOR) implements AuthBackend {
            public function __construct(private readonly string $principal)
            {
            }

            /** @return array{bool, string} */
            public function check(RequestInterface $request, ResponseInterface $response): array
            {
                return [true, $this->principal];
            }

            public function challenge(RequestInterface $request, ResponseInterface $response): void
            {
            }
        });
        $server->addPlugin($auth);
        $auth->check(new Request('DELETE', '/'), new Response());

        $plugin = new MembershipPlugin();
        $plugin->allowUnauthenticatedAccess = false;
        $server->addPlugin($plugin);

        return $plugin;
    }
}
