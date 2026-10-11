<?php

declare(strict_types=1);

namespace Calflex\Tests\Integration;

use Calflex\Database;
use Calflex\Delegation;
use Calflex\Service;
use Calflex\Tests\EventFixture;
use Calflex\Tests\Multistatus;
use Calflex\Tests\Signer;
use PHPUnit\Framework\TestCase;

/**
 * E03-R08 — access follows the API's membership table.
 *
 * The API owns `public.calendar_members`, so this suite changes those rows
 * directly, exactly as E06 will, and asserts what the *next* CalDAV request
 * makes of the change. Every calendar it touches gets its `public.calendars`
 * row and its `calendar_members` rows the way the API will create them; the
 * SabreDAV collection itself is then created through MKCALENDAR, as E05-R03
 * will.
 *
 * A member always reaches a calendar through their own home:
 * `/calendars/<their users.id>/<calendars.id>/`. Another member's href is not
 * an alias for it, so the assertions below address every object under the
 * acting user's own collection href.
 */
final class MembershipTest extends TestCase
{
    private \PDO $api;
    private \PDO $dav;
    private string $owner;
    private string $editor;
    private string $viewer;
    private string $stranger;
    private string $calendar;
    private ?string $other = null;
    private string $keyId;
    private string $key;
    /** @var list<string> */
    private array $nonces = [];
    /** @var list<string> */
    private array $extras = [];

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
        $keys = Delegation::keys(getenv('CALFLEX_DELEGATION_KEYS') ?: '');
        self::assertNotEmpty($keys);
        $this->keyId = (string) array_key_first($keys);
        $this->key = $keys[$this->keyId];
        $this->owner = self::uuid();
        $this->editor = self::uuid();
        $this->viewer = self::uuid();
        $this->stranger = self::uuid();
        $this->calendar = self::uuid();
        foreach ([$this->owner, $this->editor, $this->viewer, $this->stranger] as $id) {
            $q = $this->api->prepare('INSERT INTO public.users (id, idp_subject, handle, email) VALUES (?, ?, ?, ?)');
            $q->execute([$id, $id, $id, $id . '@example.invalid']);
        }
        $this->register($this->calendar);
        $this->member($this->calendar, $this->owner, 'owner');
        $this->member($this->calendar, $this->editor, 'editor');
        $this->member($this->calendar, $this->viewer, 'viewer');
    }

    protected function tearDown(): void
    {
        if (!isset($this->owner)) {
            return;
        }
        $calendars = [$this->calendar];
        if ($this->other !== null) {
            $calendars[] = $this->other;
        }
        $owners = array_merge([$this->owner], $this->extras);
        foreach ($owners as $member) {
            foreach ($calendars as $calendar) {
                // Deletes through DAV as that member; a collection an earlier
                // assertion already deleted answers 404, not a failure here.
                $this->request('DELETE', $this->memberPath($calendar, $member), '', [], $member);
            }
        }
        $q = $this->dav->prepare('DELETE FROM sabredav.propertystorage WHERE path LIKE ?');
        $q->execute(['calendars/%']);
        foreach ($this->nonces as $nonce) {
            $q = $this->dav->prepare('DELETE FROM public.delegation_nonces WHERE nonce = ?');
            $q->execute([$nonce]);
        }
        $q = $this->api->prepare('DELETE FROM public.calendar_members WHERE calendar_id = ANY(?)');
        $q->execute(['{' . implode(',', $calendars) . '}']);
        $q = $this->api->prepare('DELETE FROM public.calendars WHERE id = ANY(?)');
        $q->execute(['{' . implode(',', $calendars) . '}']);
        $q = $this->api->prepare('DELETE FROM public.users WHERE id = ANY(?)');
        $q->execute(['{' . implode(',', [$this->owner, $this->editor, $this->viewer, $this->stranger]) . '}']);
    }

    /** The `public.calendars` row the API creates before a collection exists. */
    private function register(string $calendar): void
    {
        $q = $this->api->prepare("INSERT INTO public.calendars (id, owner_id, mode, caldav_href, meta_envelope, meta_epoch) VALUES (?, ?, 'private', ?, decode('00', 'hex'), 1)");
        $q->execute([$calendar, $this->owner, $this->memberPath($calendar)]);
    }

    private function member(string $calendar, string $user, string $role): void
    {
        $q = $this->api->prepare('INSERT INTO public.calendar_members (calendar_id, user_id, role) VALUES (?, ?, ?)');
        $q->execute([$calendar, $user, $role]);
    }

    private function role(string $calendar, string $user, string $role): void
    {
        $q = $this->api->prepare('UPDATE public.calendar_members SET role = ? WHERE calendar_id = ? AND user_id = ?');
        $q->execute([$role, $calendar, $user]);
        self::assertSame(1, $q->rowCount(), 'The membership row must exist to be changed');
    }

    private function unmember(string $calendar, string $user): void
    {
        $q = $this->api->prepare('DELETE FROM public.calendar_members WHERE calendar_id = ? AND user_id = ?');
        $q->execute([$calendar, $user]);
        self::assertSame(1, $q->rowCount());
    }

    /** The href a member reads the calendar at: their own home, never another's. */
    private function memberPath(string $calendar, string $member = ''): string
    {
        return '/calendars/' . ($member === '' ? $this->owner : $member) . '/' . $calendar . '/';
    }

    private function home(?string $member = null): string
    {
        return '/calendars/' . ($member ?? $this->owner) . '/';
    }

    private function sign(string $method, string $target, string $actor): string
    {
        $nonce = Delegation::encode(random_bytes(16));
        $this->nonces[] = $nonce;
        return Signer::header($this->keyId, $this->key, $actor, $method, $target, null, $nonce);
    }

    /** @param array<string, string> $extra
     * @return array{status: int, headers: array<string, string>, body: string}
     */
    private function request(string $method, string $target, string $body = '', array $extra = [], ?string $actor = null): array
    {
        $origin = getenv('CALFLEX_CALDAV_TEST_ORIGIN') ?: '';
        $extra['X-Calflex-Principal'] = $this->sign($method, $target, $actor ?? $this->owner);
        $extra['Content-Type'] ??= 'application/xml; charset=utf-8';
        $lines = [];
        foreach ($extra as $name => $value) {
            $lines[] = "$name: $value";
        }
        $context = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $lines), 'content' => $body, 'ignore_errors' => true, 'follow_location' => 0, 'timeout' => 20]]);
        $response = @file_get_contents($origin . $target, false, $context);
        self::assertTrue($response !== false, 'Listener request failed');
        $rawHeaders = $http_response_header;
        preg_match('/^HTTP\/\S+ (\d+)/', $rawHeaders[0] ?? '', $status);
        $headers = [];
        foreach (array_slice($rawHeaders, 1) as $line) {
            if (str_contains($line, ':')) {
                [$name, $value] = explode(':', $line, 2);
                if ('date' !== strtolower($name)) {
                    $headers[strtolower($name)] = trim($value);
                }
            }
        }
        ksort($headers);
        return ['status' => (int) ($status[1] ?? 0), 'headers' => $headers, 'body' => (string) $response];
    }

    /** MKCALENDAR the collection in the owner's home and return the owner's href. */
    private function collect(string $calendar): string
    {
        $path = $this->memberPath($calendar);
        self::assertSame(201, $this->request('MKCALENDAR', $path)['status']);

        return $path;
    }

    private function event(): string
    {
        return EventFixture::create(self::uuid());
    }

    private function calendarQuery(): string
    {
        return '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>';
    }

    /** @return array{status: int, headers: array<string, string>, body: string} */
    private function sync(string $path, ?string $actor = null): array
    {
        return $this->request('REPORT', $path, '<d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>', [], $actor);
    }

    /** @return list<string> the hrefs a Depth-1 listing of a member's home returns */
    private function listing(string $member): array
    {
        $response = $this->request('PROPFIND', $this->home($member), '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', ['Depth' => '1'], $member);
        self::assertSame(207, $response['status']);

        return Multistatus::responseHrefs($response['body']);
    }

    /** @return list<string> the privileges `{DAV:}current-user-privilege-set` advertises */
    private function privileges(string $path, string $actor): array
    {
        $response = $this->request('PROPFIND', $path, '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-privilege-set/></d:prop></d:propfind>', ['Depth' => '0'], $actor);
        self::assertSame(207, $response['status']);
        $document = new \DOMDocument();
        self::assertTrue($document->loadXML($response['body']));
        $names = [];
        foreach ($document->getElementsByTagNameNS('DAV:', 'privilege') as $privilege) {
            foreach ($privilege->childNodes as $child) {
                if ($child instanceof \DOMElement) {
                    $names[] = '{' . $child->namespaceURI . '}' . $child->localName;
                }
            }
        }

        return $names;
    }

    /**
     * The requirement's first acceptance pair: a viewer reads everything a
     * viewer should and writes nothing, and the collection advertises exactly
     * that so a stock app draws it read-only.
     */
    public function testViewerReadsEverythingAndWritesNothing(): void
    {
        $this->collect($this->calendar);
        $viewerPath = $this->memberPath($this->calendar, $this->viewer);
        $stored = self::uuid() . '.ics';
        self::assertSame(201, $this->request('PUT', $this->memberPath($this->calendar) . $stored, $this->event())['status']);
        $object = $viewerPath . $stored;

        self::assertSame(207, $this->request('PROPFIND', $viewerPath, '', ['Depth' => '0'], $this->viewer)['status']);
        self::assertSame(200, $this->request('GET', $object, '', [], $this->viewer)['status']);
        self::assertSame(207, $this->request('REPORT', $viewerPath, $this->calendarQuery(), ['Depth' => '1'], $this->viewer)['status']);
        self::assertSame(207, $this->sync($viewerPath, $this->viewer)['status']);

        $privileges = $this->privileges($viewerPath, $this->viewer);
        self::assertContains('{DAV:}read', $privileges);
        foreach (['{DAV:}write', '{DAV:}write-content', '{DAV:}write-properties', '{DAV:}bind', '{DAV:}unbind', '{DAV:}write-acl'] as $write) {
            self::assertNotContains($write, $privileges, 'A viewer must not be advertised a write privilege');
        }

        // Writing is refused with 403 -- the collection exists for them -- and
        // nothing is stored or removed.
        $fresh = $viewerPath . self::uuid() . '.ics';
        self::assertSame(403, $this->request('PUT', $fresh, $this->event(), [], $this->viewer)['status']);
        self::assertSame(404, $this->request('GET', $fresh, '', [], $this->viewer)['status']);
        self::assertSame(403, $this->request('PUT', $object, $this->event(), [], $this->viewer)['status']);
        self::assertSame(403, $this->request('DELETE', $object, '', [], $this->viewer)['status']);
        self::assertSame(200, $this->request('GET', $object, '', [], $this->viewer)['status'], 'A refused write must not have deleted the object');
        self::assertSame(403, $this->request('PROPPATCH', $viewerPath, $this->propertyBody('<d:displayname>Private calendar</d:displayname>'), [], $this->viewer)['status']);
        self::assertSame(403, $this->request('DELETE', $viewerPath, '', [], $this->viewer)['status']);
        self::assertSame(207, $this->request('PROPFIND', $viewerPath, '', ['Depth' => '0'], $this->viewer)['status'], 'A refused delete must not have removed the collection');
    }

    /**
     * The acceptance test proper: the role in `calendar_members` is what the
     * next request follows, in both directions.
     */
    public function testAChangedRoleAppliesToTheNextRequest(): void
    {
        $this->collect($this->calendar);
        $path = $this->memberPath($this->calendar, $this->editor);
        $object = $path . self::uuid() . '.ics';
        $event = $this->event();

        // The membership table is the API's; changing it changes the next request.
        $this->role($this->calendar, $this->editor, 'viewer');
        self::assertSame(403, $this->request('PUT', $object, $event, [], $this->editor)['status']);

        $this->role($this->calendar, $this->editor, 'editor');
        self::assertSame(201, $this->request('PUT', $object, $event, [], $this->editor)['status']);
        self::assertSame(204, $this->request('PUT', $object, $event, [], $this->editor)['status']);
        self::assertSame(204, $this->request('DELETE', $object, '', [], $this->editor)['status']);

        // And back again: the promoted privileges are withdrawn, not remembered.
        $this->role($this->calendar, $this->editor, 'viewer');
        self::assertSame(403, $this->request('PUT', $object, $event, [], $this->editor)['status']);
        self::assertSame(404, $this->request('GET', $object, '', [], $this->editor)['status']);

        $this->role($this->calendar, $this->editor, 'owner');
        self::assertSame(201, $this->request('PUT', $object, $event, [], $this->editor)['status']);
        self::assertSame(207, $this->request('PROPPATCH', $path, $this->propertyBody('<d:displayname>Private calendar</d:displayname>'), [], $this->editor)['status']);
    }

    /**
     * The object's advertised privilege set, exactly, for every role. A calendar
     * object implements `IACL`, so the `{DAV:}write` aggregate would advertise
     * `{DAV:}write-acl` and `{DAV:}unlock` on it; E03-R08 keeps every ACL change
     * out of CalDAV for every role, and locking is not installed. An editor and
     * the owner get `{DAV:}write-content` (the DAVACL check when an existing
     * object is overwritten) and `{DAV:}write-properties` (the check a
     * `PROPPATCH` on the object makes, which is what lets the E03-R09 guard
     * refuse a Private object's dead properties); creating and deleting one is
     * `{DAV:}bind`/`{DAV:}unbind` on the collection above, not on the object.
     * `{DAV:}read` aggregates `{DAV:}read-acl` and
     * `{DAV:}read-current-user-privilege-set`, which is why those two appear.
     */
    public function testAnObjectAdvertisesExactlyTheRolePrivileges(): void
    {
        $this->collect($this->calendar);
        $stored = self::uuid() . '.ics';
        self::assertSame(201, $this->request('PUT', $this->memberPath($this->calendar) . $stored, $this->event())['status']);

        $read = ['{DAV:}read', '{DAV:}read-acl', '{DAV:}read-current-user-privilege-set'];
        $write = ['{DAV:}write-content', '{DAV:}write-properties'];
        $expected = [
            $this->viewer => $read,
            $this->editor => array_merge($read, $write),
            $this->owner => array_merge($read, $write),
        ];
        foreach ($expected as $actor => $want) {
            $privileges = $this->privileges($this->memberPath($this->calendar, $actor) . $stored, $actor);
            sort($want);
            sort($privileges);
            self::assertSame($want, $privileges, 'The object advertises exactly what the role grants');
            foreach (['{DAV:}write', '{DAV:}write-acl', '{DAV:}bind', '{DAV:}unbind', '{DAV:}unlock'] as $absent) {
                self::assertNotContains($absent, $privileges, 'An object must not advertise ' . $absent);
            }
        }
    }

    /**
     * An editor writes objects but not collection properties and not the
     * collection itself; that is the owner's.
     */
    public function testCollectionPropertiesAndDeletionAreTheOwnersOnly(): void
    {
        $this->collect($this->calendar);
        $body = $this->propertyBody('<d:displayname>Private calendar</d:displayname>');
        $editorPath = $this->memberPath($this->calendar, $this->editor);
        $viewerPath = $this->memberPath($this->calendar, $this->viewer);

        self::assertSame(403, $this->request('PROPPATCH', $editorPath, $body, [], $this->editor)['status']);
        self::assertSame(403, $this->request('PROPPATCH', $viewerPath, $body, [], $this->viewer)['status']);
        self::assertSame(403, $this->request('DELETE', $editorPath, '', [], $this->editor)['status']);
        self::assertSame(403, $this->request('DELETE', $viewerPath, '', [], $this->viewer)['status']);
        self::assertSame(207, $this->request('PROPFIND', $editorPath, '', ['Depth' => '0'], $this->editor)['status'], 'A refused delete must not have removed the collection');

        self::assertSame(207, $this->request('PROPPATCH', $this->memberPath($this->calendar), $body)['status'], 'The owner writes collection properties through their own href');
        self::assertSame(204, $this->request('DELETE', $this->memberPath($this->calendar), '', [], $this->owner)['status']);
        self::assertSame(404, $this->request('PROPFIND', $editorPath, '', ['Depth' => '0'], $this->editor)['status']);
        self::assertSame(404, $this->request('GET', $this->memberPath($this->calendar))['status']);
    }

    /**
     * A removed member is not a 403: the calendar is not theirs any more, so it
     * is not in their home and every href below it is 404.
     */
    public function testARemovedMemberIsNotFoundEverywhere(): void
    {
        $this->collect($this->calendar);
        $object = $this->memberPath($this->calendar) . self::uuid() . '.ics';
        self::assertSame(201, $this->request('PUT', $object, $this->event())['status']);
        $viewerPath = $this->memberPath($this->calendar, $this->viewer);
        self::assertContains($viewerPath, $this->listing($this->viewer));

        $this->unmember($this->calendar, $this->viewer);

        $hrefs = $this->listing($this->viewer);
        self::assertNotContains($viewerPath, $hrefs);
        self::assertNotContains($this->memberPath($this->calendar), $hrefs);

        $viewerObject = $viewerPath . basename($object);
        $absent = [
            ['PROPFIND', $viewerPath, '', ['Depth' => '0']],
            ['GET', $viewerPath, '', []],
            ['REPORT', $viewerPath, $this->calendarQuery(), ['Depth' => '1']],
            ['DELETE', $viewerPath, '', []],
            ['PROPFIND', $viewerObject, '', ['Depth' => '0']],
            ['GET', $viewerObject, '', []],
            ['DELETE', $viewerObject, '', []],
            ['PUT', $viewerObject, $this->event(), []],
        ];
        foreach ($absent as [$method, $target, $body, $extra]) {
            $response = $this->request($method, $target, $body, $extra, $this->viewer);
            self::assertSame(404, $response['status'], $method . ' ' . $target . ' must be 404 for a removed member, never 403');
        }

        // Nobody else lost anything.
        self::assertSame(207, $this->request('PROPFIND', $this->memberPath($this->calendar), '', ['Depth' => '0'])['status']);
        self::assertSame(200, $this->request('GET', $object)['status']);
    }

    /**
     * A member sees the same calendar at their own home href: the collection is
     * reached through the acting user's own home, never through another's.
     */
    public function testAMemberSeesTheCalendarInTheirOwnHome(): void
    {
        $this->collect($this->calendar);
        $stored = self::uuid() . '.ics';
        self::assertSame(201, $this->request('PUT', $this->memberPath($this->calendar) . $stored, $this->event())['status']);
        $editorPath = $this->memberPath($this->calendar, $this->editor);

        $hrefs = $this->listing($this->editor);
        self::assertSame(1, count(array_keys($hrefs, $editorPath, true)), 'The calendar must be listed once, at the member own href');
        foreach ($hrefs as $href) {
            self::assertStringNotContainsString($this->owner, $href, 'The listing must not hand out another user home');
        }

        self::assertSame(207, $this->request('PROPFIND', $editorPath, '', ['Depth' => '0'], $this->editor)['status']);
        self::assertSame(200, $this->request('GET', $editorPath . $stored, '', [], $this->editor)['status']);
        self::assertSame(207, $this->sync($editorPath, $this->editor)['status']);
        self::assertSame(404, $this->request('GET', $this->memberPath($this->calendar) . $stored, '', [], $this->editor)['status'], 'Another member href is not an alias');
    }

    /**
     * A user who is not a member sees neither the calendar nor the home it lives
     * in, exactly like an id that exists nowhere.
     */
    public function testANonMemberSeesNothing(): void
    {
        $this->collect($this->calendar);
        $hrefs = $this->listing($this->stranger);
        self::assertNotContains($this->memberPath($this->calendar, $this->stranger), $hrefs);

        self::assertSame(404, $this->request('PROPFIND', $this->memberPath($this->calendar, $this->stranger), '', ['Depth' => '0'], $this->stranger)['status']);
        self::assertSame(404, $this->request('GET', $this->memberPath($this->calendar), '', [], $this->stranger)['status']);
        self::assertSame(404, $this->request('PROPFIND', $this->home(), '', ['Depth' => '0'], $this->stranger)['status']);

        $foreign = $this->home() . self::uuid() . '/';
        self::assertSame(409, $this->request('MKCALENDAR', $foreign, '', [], $this->stranger)['status']);
        self::assertSame(404, $this->request('PROPFIND', '/calendars/' . self::uuid() . '/', '', ['Depth' => '0'], $this->stranger)['status']);
    }

    /**
     * Permissions never change through CalDAV: `ACL` is refused for everyone and
     * a collection takes no POST at all.
     */
    public function testAclAndSharePostAreRefused(): void
    {
        $this->collect($this->calendar);
        $acl = '<d:acl xmlns:d="DAV:"><d:ace><d:principal><d:href>' . $this->home($this->viewer) . '</d:href></d:principal><d:grant><d:privilege><d:write/></d:privilege></d:grant></d:ace></d:acl>';
        $share = '<CS:share-resource xmlns:CS="http://calendarserver.org/ns/"><CS:share><CS:href>mailto:someone@example.invalid</CS:href><CS:common-name>someone</CS:common-name></CS:share></CS:share-resource>';

        foreach ([$this->owner, $this->editor, $this->viewer] as $actor) {
            $path = $this->memberPath($this->calendar, $actor);
            self::assertSame(403, $this->request('ACL', $path, $acl, [], $actor)['status'], 'ACL must be refused for every role');
            self::assertSame(403, $this->request('POST', $path, $share, [], $actor)['status'], 'A share-resource POST must be refused for every role');
        }

        // The refused ACL and the refused property writes changed nothing.
        $ownerPath = $this->memberPath($this->calendar);
        $editorPath = $this->memberPath($this->calendar, $this->editor);
        self::assertSame(403, $this->request('PROPPATCH', $editorPath, $this->propertyBody('<d:acl xmlns:d="DAV:"/>'), [], $this->editor)['status']);
        self::assertSame(403, $this->request('PROPPATCH', $editorPath, $this->propertyBody('<CS:shared-url xmlns:CS="http://calendarserver.org/ns/">https://example.invalid/</CS:shared-url>'), [], $this->editor)['status']);
        self::assertSame(403, $this->request('PROPPATCH', $ownerPath, $this->propertyBody('<CS:shared-url xmlns:CS="http://calendarserver.org/ns/">https://example.invalid/</CS:shared-url>'))['status']);

        $advertised = $this->request('PROPFIND', $ownerPath, '<d:propfind xmlns:d="DAV:"><d:prop><d:acl/></d:prop></d:propfind>', ['Depth' => '0']);
        self::assertSame(207, $advertised['status']);
        self::assertStringNotContainsString($this->viewer, $advertised['body'], 'A refused ACL request must not have granted anything');
    }

    /**
     * The same two refusals taken straight from the service, so they also hold
     * on a SAPI that does not serve the `ACL` method. PHP's built-in server —
     * what a sandbox run of this suite uses — answers its own 501 to `ACL`
     * before the script ever runs; FrankenPHP (the runtime image) passes it
     * through, which is what the HTTP assertion above exercises there.
     */
    public function testAclAndSharePostAreRefusedByTheServerItself(): void
    {
        $this->collect($this->calendar);
        $acl = '<d:acl xmlns:d="DAV:"><d:ace><d:principal><d:href>' . $this->home($this->viewer) . '</d:href></d:principal><d:grant><d:privilege><d:write/></d:privilege></d:grant></d:ace></d:acl>';
        $share = '<CS:share-resource xmlns:CS="http://calendarserver.org/ns/"><CS:share><CS:href>mailto:someone@example.invalid</CS:href></CS:share></CS:share-resource>';
        foreach ([$this->owner, $this->editor, $this->viewer] as $actor) {
            $path = $this->memberPath($this->calendar, $actor);
            self::assertSame(403, $this->responseStatus($actor, 'ACL', $path, $acl), 'ACL must be refused on a collection for every role');
            self::assertSame(403, $this->responseStatus($actor, 'ACL', $this->home($actor), $acl), 'ACL must be refused on a home for every role');
            self::assertSame(403, $this->responseStatus($actor, 'POST', $path, $share), 'A share-resource POST must be refused');
        }
    }

    /** The status a method gets from the real service, without an HTTP client. */
    private function responseStatus(string $actor, string $method, string $path, string $body): int
    {
        $server = Service::create($this->dav, $actor);
        $request = new \Sabre\HTTP\Request($method, $path, ['Content-Type' => 'application/xml; charset=utf-8'], $body);
        $request->setBaseUrl('/');
        $response = new \Sabre\HTTP\Response();
        $server->httpRequest = $request;
        $server->httpResponse = $response;
        try {
            $server->invokeMethod($request, $response, false);
        } catch (\Sabre\DAV\Exception $exception) {
            return $exception->getHTTPCode();
        }

        return (int) $response->getStatus();
    }

    /**
     * COPY needs write on the destination collection and MOVE also unbind on
     * the source, so the same role decides both.
     */
    public function testCopyAndMoveFollowTheMembershipRole(): void
    {
        $this->other = self::uuid();
        $this->register($this->other);
        foreach ([[$this->owner, 'owner'], [$this->editor, 'editor'], [$this->viewer, 'viewer']] as [$user, $role]) {
            $this->member($this->other, $user, $role);
        }
        $this->collect($this->calendar);
        $this->collect($this->other);
        $origin = getenv('CALFLEX_CALDAV_TEST_ORIGIN') ?: '';

        // An editor writes on both sides: read on the source, write on the target.
        $object = $this->memberPath($this->calendar, $this->editor) . self::uuid() . '.ics';
        self::assertSame(201, $this->request('PUT', $object, $this->event(), [], $this->editor)['status']);
        $copied = $this->memberPath($this->other, $this->editor) . self::uuid() . '.ics';
        self::assertSame(201, $this->request('COPY', $object, '', ['Destination' => $origin . $copied, 'Overwrite' => 'F'], $this->editor)['status']);
        self::assertSame(200, $this->request('GET', $copied, '', [], $this->editor)['status']);
        $moved = $this->memberPath($this->other, $this->editor) . self::uuid() . '.ics';
        self::assertSame(201, $this->request('MOVE', $object, '', ['Destination' => $origin . $moved, 'Overwrite' => 'F'], $this->editor)['status']);
        self::assertSame(404, $this->request('GET', $object, '', [], $this->editor)['status']);
        self::assertSame(200, $this->request('GET', $moved, '', [], $this->editor)['status']);

        // A viewer reads the source but may not write the destination, and the
        // refused write leaves both sides alone.
        $stored = self::uuid() . '.ics';
        $plain = $this->memberPath($this->calendar) . $stored;
        self::assertSame(201, $this->request('PUT', $plain, $this->event())['status']);
        $viewerObject = $this->memberPath($this->calendar, $this->viewer) . $stored;
        $denied = $this->memberPath($this->other, $this->viewer) . self::uuid() . '.ics';
        self::assertSame(403, $this->request('COPY', $viewerObject, '', ['Destination' => $origin . $denied, 'Overwrite' => 'F'], $this->viewer)['status']);
        self::assertSame(404, $this->request('GET', $denied, '', [], $this->viewer)['status']);
        self::assertSame(403, $this->request('MOVE', $viewerObject, '', ['Destination' => $origin . $denied, 'Overwrite' => 'F'], $this->viewer)['status']);
        self::assertSame(200, $this->request('GET', $viewerObject, '', [], $this->viewer)['status'], 'A refused MOVE must leave the source alone');
    }

    private function propertyBody(string $properties): string
    {
        return '<d:propertyupdate xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop>' . $properties . '</d:prop></d:set></d:propertyupdate>';
    }
}
