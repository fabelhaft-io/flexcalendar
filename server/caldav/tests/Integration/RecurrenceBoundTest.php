<?php

declare(strict_types=1);

namespace Calflex\Tests\Integration;

use Calflex\Database;
use Calflex\Service;
use PHPUnit\Framework\TestCase;
use Sabre\HTTP\Request;
use Sabre\HTTP\Response;

/**
 * E03-R12 — the recurrence bound on the service.
 *
 * The service raises `sabre/vobject`'s bound to 50,000, so the finite series
 * SabreDAV walks on every write (a daily `COUNT=4000`, a daily `UNTIL` in 2040,
 * an hourly series for a year) are stored instead of answering a `500`; a
 * series over the bound is RFC 4791's `403` `CALDAV:max-instances` and stores
 * nothing; a `calendar-query` whose `time-range` fast-forwards a daily unbounded
 * series that started 20 years earlier answers the instance in the window; and
 * every collection advertises the bound.
 *
 * Requests go through the real `Service::create` in this process, on the
 * Postgres the other `tests/Integration` suites use. A `PUT` is refused by
 * throwing, exactly as `Service::run` sees it, so the catch below is where the
 * answer is built — the same `Service::errorResponse` the front controller
 * calls. Only the private mode exists in M1 (ADR 0003), and the refusal is not
 * part of the private write guard, so the bound applies to a shared or
 * published collection too; there is simply no way to store one yet.
 */
final class RecurrenceBoundTest extends TestCase
{
    private \PDO $api;
    private \PDO $dav;
    private string $owner;
    private string $calendar;

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
        $this->calendar = self::uuid();
        $q = $this->api->prepare('INSERT INTO public.users (id, idp_subject, handle, email) VALUES (?, ?, ?, ?)');
        $q->execute([$this->owner, $this->owner, $this->owner, $this->owner . '@example.invalid']);
        $q = $this->api->prepare("INSERT INTO public.calendars (id, owner_id, mode, caldav_href, meta_envelope, meta_epoch) VALUES (?, ?, 'private', ?, decode('00', 'hex'), 1)");
        $q->execute([$this->calendar, $this->owner, $this->path()]);
        $q = $this->api->prepare("INSERT INTO public.calendar_members (calendar_id, user_id, role) VALUES (?, ?, 'owner')");
        $q->execute([$this->calendar, $this->owner]);
    }

    protected function tearDown(): void
    {
        if (!isset($this->owner)) {
            return;
        }
        $this->request('DELETE', $this->path());
        $q = $this->dav->prepare('DELETE FROM sabredav.propertystorage WHERE path LIKE ?');
        $q->execute(['calendars/%']);
        $q = $this->api->prepare('DELETE FROM public.calendar_members WHERE calendar_id = ?');
        $q->execute([$this->calendar]);
        $q = $this->api->prepare('DELETE FROM public.calendars WHERE id = ?');
        $q->execute([$this->calendar]);
        $q = $this->api->prepare('DELETE FROM public.users WHERE id = ?');
        $q->execute([$this->owner]);
    }

    /** The acting owner's collection href. */
    private function path(): string
    {
        return '/calendars/' . $this->owner . '/' . $this->calendar . '/';
    }

    /**
     * One request through the real service, with `Service::errorResponse`
     * standing in for the front controller's catch.
     *
     * @param array<string, string> $headers
     *
     * @return array{status: int, contentType: string, body: string}
     */
    private function request(string $method, string $path, string $body = '', array $headers = []): array
    {
        $headers['Content-Type'] ??= 'application/xml; charset=utf-8';
        $server = Service::create($this->dav, $this->owner);
        $request = new Request($method, $path, $headers, $body);
        $request->setBaseUrl('/');
        $response = new Response();
        $server->httpRequest = $request;
        $server->httpResponse = $response;
        try {
            $server->invokeMethod($request, $response, false);
        } catch (\Throwable $exception) {
            Service::errorResponse($server, $exception);
        }

        return [
            'status' => (int) $server->httpResponse->getStatus(),
            'contentType' => (string) $server->httpResponse->getHeader('Content-Type'),
            'body' => $server->httpResponse->getBodyAsString(),
        ];
    }

    /** The collection, created the way E05-R03 will create it. */
    private function collect(): void
    {
        self::assertSame(201, $this->request('MKCALENDAR', $this->path())['status']);
    }

    /**
     * A Private skeleton: the guard's allow-list, and exactly one envelope hash
     * per VEVENT, is what a write into a Private collection needs (E03-R09).
     */
    private function series(string $rrule, string $start = '20260101T090000Z', string $end = '20260101T100000Z'): string
    {
        return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Calflex//EN\r\n"
            . "BEGIN:VEVENT\r\nUID:" . self::uuid() . "\r\n"
            . "DTSTAMP:20260101T000000Z\r\nDTSTART:" . $start . "\r\nDTEND:" . $end . "\r\n"
            . 'RRULE:' . $rrule . "\r\nX-CALFLEX-ENVELOPE-SHA256:" . str_repeat('a', 64)
            . "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    }

    /** @return array{status: int, contentType: string, body: string} */
    private function put(string $object, string $rrule, string $start = '20260101T090000Z', string $end = '20260101T100000Z'): array
    {
        return $this->request('PUT', $this->path() . $object, $this->series($rrule, $start, $end), ['Content-Type' => 'text/calendar', 'If-None-Match' => '*']);
    }

    /** @return array{0: mixed, 1: mixed} the SabreDAV calendar id pair */
    private function ids(): array
    {
        $q = $this->dav->prepare('SELECT calendarid, id FROM sabredav.calendarinstances WHERE lower(uri) = ?');
        $q->execute([$this->calendar]);
        $row = $q->fetch(\PDO::FETCH_ASSOC);
        self::assertIsArray($row, 'The collection must have a SabreDAV instance row');

        return [$row['calendarid'], $row['id']];
    }

    /** @return array<string, int> what a refused write must not add to */
    private function counts(): array
    {
        [$calendarId] = $this->ids();
        $counts = [];
        foreach ([
            'objects' => ['sabredav.calendarobjects', 'calendarid'],
            'changes' => ['sabredav.calendarchanges', 'calendarid'],
        ] as $key => [$table, $column]) {
            $q = $this->dav->prepare("SELECT count(*) FROM $table WHERE $column = ?");
            $q->execute([$calendarId]);
            $counts[$key] = (int) $q->fetchColumn();
        }
        $q = $this->dav->prepare('SELECT count(*) FROM public.caldav_changes WHERE calendar_id = ?');
        $q->execute([$this->calendar]);
        $counts['outbox'] = (int) $q->fetchColumn();

        return $counts;
    }

    public function testFiniteSeriesOverTheDefaultBoundAreStored(): void
    {
        $this->collect();
        $series = [
            'daily count' => 'FREQ=DAILY;COUNT=4000',
            'daily until' => 'FREQ=DAILY;UNTIL=20401231T090000Z',
            'hourly year' => 'FREQ=HOURLY;COUNT=8760',
        ];
        foreach ($series as $name => $rrule) {
            $response = $this->put(self::uuid() . '.ics', $rrule);
            self::assertSame(201, $response['status'], $name . ' must be stored, not refused: ' . $response['body']);
            self::assertStringNotContainsString('max-instances', $response['body'], $name);
        }
        self::assertSame(3, $this->counts()['objects']);
    }

    public function testASeriesOverTheBoundIsRefusedAndStoresNothing(): void
    {
        $this->collect();
        // 60,000 minutes is over 50,000 instances and well before 2038, so the
        // walk SabreDAV makes on write is the one that throws.
        $before = $this->counts();
        $object = self::uuid() . '.ics';
        $response = $this->put($object, 'FREQ=MINUTELY;COUNT=60000');
        self::assertSame(403, $response['status']);
        self::assertSame('application/xml; charset=utf-8', $response['contentType']);
        $xml = new \DOMDocument();
        self::assertTrue($xml->loadXML($response['body']));
        self::assertSame('DAV:', $xml->documentElement->namespaceURI);
        self::assertSame('error', $xml->documentElement->localName);
        $condition = $xml->getElementsByTagNameNS('urn:ietf:params:xml:ns:caldav', 'max-instances');
        self::assertSame(1, $condition->length, "The refusal must carry RFC 4791's max-instances precondition");
        self::assertSame(0, $xml->getElementsByTagNameNS('http://sabredav.org/ns', 'message')->length);
        self::assertStringNotContainsString('MINUTELY', $response['body']);
        self::assertSame($before, $this->counts(), 'A refused write must leave nothing behind');
        self::assertSame(404, $this->request('GET', $this->path() . $object)['status']);
    }

    public function testAQueryOverALongUnboundedSeriesAnswersTheInstanceInTheWindow(): void
    {
        $this->collect();
        $object = self::uuid() . '.ics';
        // An unbounded daily series beginning twenty years before the window.
        self::assertSame(201, $this->put($object, 'FREQ=DAILY', '20060101T090000Z', '20060101T100000Z')['status']);
        $query = '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            . '<d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR">'
            . '<c:comp-filter name="VEVENT"><c:time-range start="20260602T090000Z" end="20260602T100000Z"/>'
            . '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
        $response = $this->request('REPORT', $this->path(), $query, ['Depth' => '1']);
        self::assertSame(207, $response['status']);
        self::assertStringContainsString($object, $response['body']);
        self::assertStringNotContainsString('max-instances', $response['body']);
    }

    public function testEveryCalendarCollectionAdvertisesTheBound(): void
    {
        $this->collect();
        $propfind = '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            . '<d:prop><c:max-instances/></d:prop></d:propfind>';
        $response = $this->request('PROPFIND', $this->path(), $propfind, ['Depth' => '0']);
        self::assertSame(207, $response['status']);
        $xml = new \DOMDocument();
        self::assertTrue($xml->loadXML($response['body']));
        $nodes = $xml->getElementsByTagNameNS('urn:ietf:params:xml:ns:caldav', 'max-instances');
        self::assertSame(1, $nodes->length);
        self::assertSame('50000', $nodes->item(0)->textContent);
    }
}
