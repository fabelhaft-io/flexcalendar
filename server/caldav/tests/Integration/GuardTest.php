<?php

declare(strict_types=1);

namespace Calflex\Tests\Integration;

use Calflex\Database;
use Calflex\Delegation;
use Calflex\Tests\Signer;
use PHPUnit\Framework\TestCase;

final class GuardTest extends TestCase
{
    private \PDO $api;
    private \PDO $dav;
    private string $a;
    private string $b;
    private string $calendar;
    private string $keyId;
    private string $key;
    /** @var list<string> */
    private array $nonces = [];
    /** @var list<string> */
    private array $extraCollections = [];
    /** @var list<string> the public.calendars rows those collections are bound to */
    private array $extraCalendars = [];

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
        $this->a = self::uuid();
        $this->b = self::uuid();
        $this->calendar = self::uuid();
        foreach ([$this->a, $this->b] as $id) {
            $q = $this->api->prepare('INSERT INTO public.users (id, idp_subject, handle, email) VALUES (?, ?, ?, ?)');
            $q->execute([$id, $id, $id, $id . '@example.invalid']);
        }
        $q = $this->api->prepare("INSERT INTO public.calendars (id, owner_id, mode, caldav_href, meta_envelope, meta_epoch) VALUES (?, ?, 'private', ?, decode('00', 'hex'), 1)");
        $q->execute([$this->calendar, $this->a, '/calendars/' . $this->a . '/' . $this->calendar . '/']);
        $q = $this->api->prepare("INSERT INTO public.calendar_members (calendar_id, user_id, role) VALUES (?, ?, 'owner')");
        $q->execute([$this->calendar, $this->a]);
    }

    protected function tearDown(): void
    {
        if (!isset($this->a)) {
            return;
        }
        // Remove Sabre data through DAV as the owning principal.
        $this->request('DELETE', $this->home() . $this->calendar . '/');
        foreach ($this->extraCollections as $path) {
            $this->request('DELETE', $path);
        }
        $q = $this->dav->prepare('DELETE FROM sabredav.propertystorage WHERE path LIKE ?');
        $q->execute(['calendars/' . $this->a . '/%']);
        foreach ($this->nonces as $nonce) {
            $q = $this->dav->prepare('DELETE FROM public.delegation_nonces WHERE nonce = ?');
            $q->execute([$nonce]);
        }
        $q = $this->api->prepare('DELETE FROM public.calendar_members WHERE calendar_id = ANY(?)');
        $q->execute(['{' . implode(',', array_merge([$this->calendar], $this->extraCalendars)) . '}']);
        $q = $this->api->prepare('DELETE FROM public.calendars WHERE id = ANY(?)');
        $q->execute(['{' . implode(',', array_merge([$this->calendar], $this->extraCalendars)) . '}']);
        $q = $this->api->prepare('DELETE FROM public.users WHERE id IN (?, ?)');
        $q->execute([$this->a, $this->b]);
    }

    private function home(): string
    {
        return '/calendars/' . $this->a . '/';
    }

    private function sign(string $method, string $target, ?string $principal = null, ?int $time = null): string
    {
        $nonce = Delegation::encode(random_bytes(16));
        $this->nonces[] = $nonce;
        return Signer::header($this->keyId, $this->key, $principal ?? $this->a, $method, $target, $time, $nonce);
    }

    /** @param array<string, string> $extra
     * @return array{status: int, headers: array<string, string>, body: string}
     */
    private function request(string $method, string $target, string $body = '', array $extra = [], ?string $header = null, bool $public = false): array
    {
        $origin = getenv($public ? 'CALFLEX_PUBLIC_TEST_ORIGIN' : 'CALFLEX_CALDAV_TEST_ORIGIN') ?: '';
        if ($header !== '') {
            $extra['X-Calflex-Principal'] = $header ?? $this->sign($method, $target);
        }
        $extra['Content-Type'] ??= 'application/xml; charset=utf-8';
        $lines = [];
        foreach ($extra as $name => $value) {
            $lines[] = "$name: $value";
        }
        $context = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $lines), 'content' => $body, 'ignore_errors' => true, 'follow_location' => 0, 'timeout' => 20]]);
        $response = @file_get_contents($origin . $target, false, $context);
        // Never dump response content, rejected headers or event data on failure.
        self::assertTrue($response !== false, 'Listener request failed');
        $rawHeaders = $http_response_header;
        preg_match('/^HTTP\/\S+ (\d+)/', $rawHeaders[0] ?? '', $status);
        $headers = [];
        foreach (array_slice($rawHeaders, 1) as $line) {
            if (str_contains($line, ':')) {
                [$name, $value] = explode(':', $line, 2);
                if (strtolower($name) !== 'date') {
                    $headers[strtolower($name)] = trim($value);
                }
            }
        }
        foreach (['server', 'x-powered-by', 'x-sabre-version'] as $name) {
            self::assertArrayNotHasKey($name, $headers, 'Listener must not disclose versions');
        }
        ksort($headers);
        return ['status' => (int) ($status[1] ?? 0), 'headers' => $headers, 'body' => (string) $response];
    }

    /** @param array{status: int, headers: array<string, string>, body: string} $response */
    private function rejected(array $response, string $name): void
    {
        self::assertSame(403, $response['status']);
        self::assertTrue(!str_contains($response['body'], 'CALFLEX_GUARD_MARKER'), 'Response leaked marker');
        self::assertTrue(!str_contains(implode('', $response['headers']), 'CALFLEX_GUARD_MARKER'), 'Header leaked marker');
        $xml = new \DOMDocument();
        self::assertTrue($xml->loadXML($response['body']));
        self::assertSame('DAV:', $xml->documentElement->namespaceURI);
        self::assertSame('error', $xml->documentElement->localName);
        self::assertSame(1, $xml->getElementsByTagNameNS('https://flexcalendar.de/ns/caldav', 'private-skeleton-only')->length);
        self::assertSame($name, $xml->getElementsByTagNameNS('https://flexcalendar.de/ns/caldav', 'name')->item(0)?->textContent);
    }

    private function collection(): string
    {
        $path = $this->home() . $this->calendar . '/';
        self::assertSame(201, $this->request('MKCALENDAR', $path)['status']);
        return $path;
    }

    /**
     * Register a collection the way the API does (E05-R03): a `public.calendars`
     * row and the creator's `calendar_members` row. E03-R08 derives access from
     * those rows, so a collection created without them is in nobody's home.
     */
    private function register(string $id): string
    {
        $path = $this->home() . $id . '/';
        $this->extraCollections[] = $path;
        $this->extraCalendars[] = $id;
        $q = $this->api->prepare("INSERT INTO public.calendars (id, owner_id, mode, caldav_href, meta_envelope, meta_epoch) VALUES (?, ?, 'private', ?, decode('00', 'hex'), 1)");
        $q->execute([$id, $this->a, $path]);
        $q = $this->api->prepare("INSERT INTO public.calendar_members (calendar_id, user_id, role) VALUES (?, ?, 'owner')");
        $q->execute([$id, $this->a]);
        return $path;
    }

    public function testPutGuardAndMarkers(): void
    {
        $path = $this->collection();
        // E03-R11: a create names the object after the `UID` it carries.
        $uid = self::uuid();
        $object = $path . $uid . '.ics';
        $skeleton = \Calflex\Tests\GuardCases::skeleton($uid);
        self::assertSame(201, $this->request('PUT', $object, $skeleton, ['Content-Type' => 'text/calendar'])['status']);
        self::assertSame(204, $this->request('PUT', $object, $skeleton, ['Content-Type' => 'text/calendar'])['status']);
        $before = $this->request('GET', $object);
        $cases = \Calflex\Tests\GuardCases::rejected();
        // These valid RFC shapes reach the backend instead of failing RFC validation.
        $cases['ATTENDEE'][0] = \Calflex\Tests\GuardCases::eventLine('ATTENDEE:mailto:CALFLEX_GUARD_MARKER_ATTENDEE@example.invalid');
        $cases['ORGANIZER'][0] = \Calflex\Tests\GuardCases::eventLine('ORGANIZER:mailto:CALFLEX_GUARD_MARKER_ORGANIZER@example.invalid');
        $cases['VTODO'][0] = str_replace(['BEGIN:VEVENT', 'END:VEVENT', 'DTEND:20261012T110000Z'], ['BEGIN:VTODO', 'END:VTODO', 'DUE:20261012T110000Z'], \Calflex\Tests\GuardCases::eventLine('SUMMARY:CALFLEX_GUARD_MARKER_VTODO'));
        foreach (['hash_1', 'hash_2'] as $case) {
            $cases[$case][0] = str_replace('X-CALFLEX-ENVELOPE-SHA256:', 'X-CALFLEX-ENVELOPE-SHA256:CALFLEX_GUARD_MARKER_' . $case, $cases[$case][0]);
        }
        // Unit suite covers invalid RFC shapes too. Here test only shapes Sabre can store.
        $required = ['SUMMARY', 'DESCRIPTION', 'LOCATION', 'ATTENDEE', 'ORGANIZER', 'ATTACH', 'COMMENT', 'CATEGORIES', 'URL', 'CONTACT', 'RESOURCES', 'GEO', 'CLASS', 'STATUS', 'X-APPLE-STRUCTURED-LOCATION', 'TRANSP', 'PRIORITY', 'X-ANYTHING', 'lowercase', 'param_X-SECRET', 'alarm', 'VTODO', 'missing_hash', 'hash_0', 'hash_1', 'hash_2', 'trailing_property', 'trailing_document'];
        foreach ($required as $case) {
            [$body, $name] = $cases[$case];
            // Unique valid UID ensures a marker for all requests, including missing hashes.
            $body = str_replace('UID:adf46a78-3c92-4c1e-ab04-7f791296e61e', 'UID:CALFLEX_GUARD_MARKER_' . $case, $body);
            $response = $this->request('PUT', $path . self::uuid() . '.ics', $body, ['Content-Type' => 'text/calendar']);
            $this->rejected($response, $name);
        }
        // Also guard the update path and ensure no mutation occurs.
        $this->rejected($this->request('PUT', $object, \Calflex\Tests\GuardCases::eventLine('SUMMARY:CALFLEX_GUARD_MARKER_update'), ['Content-Type' => 'text/calendar']), 'SUMMARY');
        $after = $this->request('GET', $object);
        self::assertTrue($before['body'] === $after['body'], 'Rejected update changed stored skeleton');
        self::assertSame($before['headers']['etag'], $after['headers']['etag']);
        $broken = $this->request('PUT', $path . self::uuid() . '.ics', "BEGIN:VCALENDAR\r\nCALFLEX_GUARD_MARKER_broken\r\nEND:VCALENDAR", ['Content-Type' => 'text/calendar']);
        self::assertSame(415, $broken['status']);
        self::assertTrue(!str_contains($broken['body'] . implode('', $broken['headers']), 'CALFLEX_GUARD_MARKER'));
    }

    private function propertyBody(string $root, string $properties): string
    {
        $prefix = $root === 'mkcalendar' ? 'c' : 'd';
        return '<' . $prefix . ':' . $root . ' xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop>' . $properties . '</d:prop></d:set></' . $prefix . ':' . $root . '>';
    }

    public function testCollectionAndObjectProperties(): void
    {
        $path = $this->collection();
        $this->rejected($this->request('PROPPATCH', $path, $this->propertyBody('propertyupdate', '<a:calendar-color>CALFLEX_GUARD_MARKER_color</a:calendar-color>')), 'CALENDAR-COLOR');
        $this->rejected($this->request('PROPPATCH', $path, $this->propertyBody('propertyupdate', '<a:calendar-color>Private calendar</a:calendar-color>')), 'CALENDAR-COLOR');
        self::assertSame(207, $this->request('PROPPATCH', $path, $this->propertyBody('propertyupdate', '<d:displayname>Private calendar</d:displayname>'))['status']);
        $object = $path . ($uid = self::uuid()) . '.ics';
        self::assertSame(201, $this->request('PUT', $object, \Calflex\Tests\GuardCases::skeleton($uid), ['Content-Type' => 'text/calendar'])['status']);
        $this->rejected($this->request('PROPPATCH', $object, $this->propertyBody('propertyupdate', '<d:displayname>CALFLEX_GUARD_MARKER_object</d:displayname>')), 'DISPLAYNAME');
        $q = $this->dav->prepare('SELECT count(*) FROM sabredav.propertystorage WHERE path = ?');
        $q->execute([ltrim($object, '/')]);
        self::assertSame(0, (int) $q->fetchColumn());
        foreach (['MKCALENDAR', 'MKCOL'] as $method) {
            $target = $this->home() . self::uuid() . '/';
            $this->extraCollections[] = $target;
            $properties = '<d:displayname>CALFLEX_GUARD_MARKER_' . $method . '</d:displayname>';
            if ($method === 'MKCOL') {
                $properties .= '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>';
            }
            $this->rejected($this->request($method, $target, $this->propertyBody(strtolower($method), $properties)), 'DISPLAYNAME');
            self::assertSame(404, $this->request('PROPFIND', $target, '', ['Depth' => '0'])['status']);
        }
        $target = $this->register(self::uuid());
        self::assertSame(201, $this->request('MKCALENDAR', $target, $this->propertyBody('mkcalendar', '<d:displayname>Private calendar</d:displayname>'))['status']);
    }

    public function testCopyAndCrossCollectionMoveCannotBypass(): void
    {
        $source = $this->collection();
        $target = $this->register(self::uuid());
        self::assertSame(201, $this->request('MKCALENDAR', $target)['status']);
        $object = $source . ($uid = self::uuid()) . '.ics';
        self::assertSame(201, $this->request('PUT', $object, \Calflex\Tests\GuardCases::skeleton($uid), ['Content-Type' => 'text/calendar'])['status']);
        // Simulate legacy or future Shared plaintext in an otherwise valid source.
        // Direct DB fixture injection is intentional: guarded PUT must not seed it.
        $legacy = \Calflex\Tests\GuardCases::eventLine('SUMMARY:CALFLEX_GUARD_MARKER_copy_move');
        $q = $this->dav->prepare('UPDATE sabredav.calendarobjects SET calendardata = ?, size = ?, etag = ? WHERE uri = ?');
        $q->execute([$legacy, strlen($legacy), md5($legacy), basename($object)]);
        self::assertSame(1, $q->rowCount());
        foreach (['COPY', 'MOVE'] as $method) {
            $destination = $target . self::uuid() . '.ics';
            $origin = getenv('CALFLEX_CALDAV_TEST_ORIGIN') ?: '';
            $this->rejected($this->request($method, $object, '', ['Destination' => $origin . $destination, 'Overwrite' => 'F']), 'SUMMARY');
            self::assertSame(404, $this->request('GET', $destination)['status']);
            self::assertSame(200, $this->request('GET', $object)['status']);
        }
    }

    /**
     * E03-R11 — the `UID` backstop over the listener, beside the E03-R09 table
     * above. Every refusal is that same `403` with `cf:private-skeleton-only`,
     * and `cf:name` names `UID`, `OBJECT-NAME` or `RRULE`, never a value: the
     * marker a refused `UID`, object name or `X-` rule part carries appears in
     * no response body and no response header (`make test-caldav` scans the
     * service log for the same marker).
     *
     * `uid_mixed` and `update_mixed_uid` are the two rows SabreDAV answers
     * itself: its CalDAV profile validation refuses components with different
     * `UID`s with a level-3 message before the backend is reached, which is a
     * `415`, never our `403`. The guard checks them anyway — a direct backend
     * call is what the unit table pins — so the refusal exists where SabreDAV's
     * check cannot answer first.
     */
    public function testUidBackstopRefusalsAndAcceptedShapes(): void
    {
        $path = $this->collection();
        $at = fn (string $uri): string => $path . $uri;

        // Accepted: the create shape the API's own path mints — a lowercase
        // UUIDv4 under `<uid>.ics`, its `randomUUID()` and its name rule.
        $uid = self::uuid();
        self::assertSame(201, $this->request('PUT', $at($uid . '.ics'), \Calflex\Tests\GuardCases::skeleton($uid), ['Content-Type' => 'text/calendar'])['status']);

        foreach (\Calflex\Tests\GuardCases::objectCreatesRejected() as $case => $row) {
            $response = $this->request('PUT', $at($row['uri']), $row['text'], ['Content-Type' => 'text/calendar']);
            if ($case === 'uid_mixed') {
                self::assertSame(415, $response['status'], $case);
                self::assertStringNotContainsString('CALFLEX_GUARD_MARKER', $response['body'], $case);
                continue;
            }
            $this->rejected($response, $row['name']);
        }

        // Accepted: an update keeps the `UID` the store already holds, so an
        // object written while the calendar was not Private keeps its stock-app
        // `UID` (INV-03). Seeded directly in the store — a create can no longer
        // write such a `UID`, and `mode` accepts only `private` until Phase 4.
        // Its name is not `<uid>.ics` and its `UID` is not a lowercase UUIDv4,
        // so the `204` is also what shows SabreDAV routed this `PUT` to
        // `updateCalendarObject` and not to the create path.
        $seed = self::uuid();
        $seeded = $at($seed . '.ics');
        self::assertSame(201, $this->request('PUT', $seeded, \Calflex\Tests\GuardCases::skeleton($seed), ['Content-Type' => 'text/calendar'])['status']);
        $legacyUid = '1A2B3C4D-5E6F-4A0B-8C1D-2E3F4A5B6C7D';
        $legacy = \Calflex\Tests\GuardCases::skeleton($legacyUid);
        $update = $this->dav->prepare('UPDATE sabredav.calendarobjects SET uid = ?, calendardata = ?, size = ?, etag = ? WHERE uri = ?');
        $update->execute([$legacyUid, $legacy, strlen($legacy), md5($legacy), basename($seeded)]);
        self::assertSame(1, $update->rowCount(), 'The seeded row must be the object just created');
        self::assertSame(204, $this->request('PUT', $seeded, $legacy, ['Content-Type' => 'text/calendar'])['status'], 'An update keeps a stored UID that is not a UUIDv4');

        // The update table's rows rewrite an object whose stored `UID` is the
        // one they carry (`null` is a row without one, which only a direct
        // backend call can produce, so the unit table pins that row).
        $target = $at(\Calflex\Tests\GuardCases::uri());
        self::assertSame(201, $this->request('PUT', $target, \Calflex\Tests\GuardCases::skeleton(), ['Content-Type' => 'text/calendar'])['status']);
        $before = $this->request('GET', $target);
        foreach (\Calflex\Tests\GuardCases::objectUpdatesRejected() as $case => $row) {
            if ($row['stored'] === null) {
                continue;
            }
            self::assertSame(\Calflex\Tests\GuardCases::UID, $row['stored'], $case);
            $response = $this->request('PUT', $target, $row['text'], ['Content-Type' => 'text/calendar']);
            if ($case === 'update_mixed_uid') {
                self::assertSame(415, $response['status'], $case);
                continue;
            }
            $this->rejected($response, $row['name']);
        }
        $after = $this->request('GET', $target);
        self::assertTrue($before['body'] === $after['body'], 'A refused update changed the stored skeleton');
        self::assertSame($before['headers']['etag'], $after['headers']['etag']);
    }
}
