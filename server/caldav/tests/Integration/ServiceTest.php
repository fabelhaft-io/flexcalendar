<?php

declare(strict_types=1);

namespace Calflex\Tests\Integration;

use Calflex\Database;
use Calflex\Delegation;
use Calflex\Tests\Signer;
use PHPUnit\Framework\TestCase;

final class ServiceTest extends TestCase
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
        foreach ($this->nonces as $nonce) {
            $q = $this->dav->prepare('DELETE FROM public.delegation_nonces WHERE nonce = ?');
            $q->execute([$nonce]);
        }
        $q = $this->api->prepare('DELETE FROM public.calendar_members WHERE calendar_id = ?');
        $q->execute([$this->calendar]);
        $q = $this->api->prepare('DELETE FROM public.calendars WHERE id = ?');
        $q->execute([$this->calendar]);
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

    private function nonceCount(): int
    {
        $count = 0;
        foreach ($this->nonces as $nonce) {
            $q = $this->dav->prepare('SELECT count(*) FROM public.delegation_nonces WHERE nonce = ?');
            $q->execute([$nonce]);
            $count += (int) $q->fetchColumn();
        }
        return $count;
    }

    public function testAuthenticationAndIsolation(): void
    {
        $target = '/principals/' . $this->a . '/';
        $prop = '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
        $valid = $this->sign('PROPFIND', $target);
        $result = $this->request('PROPFIND', $target, $prop, ['Depth' => '0'], $valid);
        self::assertSame(207, $result['status']);
        self::assertTrue(str_contains($result['body'], '/principals/' . $this->a . '/'));
        self::assertSame(1, $this->nonceCount());
        $cases = [
            ['PROPFIND', $target, ''],
            ['PROPFIND', $target, 'CALFLEX_REJECTED_HEADER_CANARY'],
            ['PROPFIND', $target, str_replace('k=' . $this->keyId, 'k=unknown', $this->sign('PROPFIND', $target))],
            ['PROPFIND', $target, preg_replace('/s=.*/', 's=' . str_repeat('A', 43), $this->sign('PROPFIND', $target))],
            ['GET', $target, $this->sign('PROPFIND', $target)],
            ['PROPFIND', $target . '?different=1', $this->sign('PROPFIND', $target)],
            ['PROPFIND', $target, $this->sign('PROPFIND', $target, null, time() - 61)],
            ['PROPFIND', $target, $this->sign('PROPFIND', $target, null, time() + 120)],
            ['PROPFIND', $target, $valid],
            ['PROPFIND', $target, $this->sign('PROPFIND', $target, self::uuid())],
        ];
        foreach ($cases as [$method, $path, $header]) {
            $denied = $this->request($method, $path, 'CALFLEX_REJECTED_BODY_CANARY', [], $header);
            self::assertSame(401, $denied['status']);
            self::assertTrue($denied['body'] === "Unauthorized\n");
            self::assertSame('no-store', $denied['headers']['cache-control']);
            self::assertSame(1, $this->nonceCount(), 'Denied requests must leave no nonce rows');
        }
        $missing = self::uuid();
        foreach (['principals', 'calendars'] as $root) {
            $denied = $this->request('PROPFIND', '/' . $root . '/' . $this->b . '/', $prop, ['Depth' => '0']);
            $absent = $this->request('PROPFIND', '/' . $root . '/' . $missing . '/', $prop, ['Depth' => '0']);
            self::assertSame($absent['status'], $denied['status']);
            self::assertTrue($absent['body'] === $denied['body'], 'Other homes must be indistinguishable from absent homes');
        }
        $child = self::uuid();
        $denied = $this->request('MKCALENDAR', '/calendars/' . $this->b . '/' . $child . '/');
        $absent = $this->request('MKCALENDAR', '/calendars/' . $missing . '/' . $child . '/');
        self::assertSame($absent['status'], $denied['status']);
        self::assertTrue($absent['body'] === $denied['body'], 'Calendar creation must not disclose another home');
        $calendarPath = $this->home() . $this->calendar . '/';
        self::assertSame(201, $this->request('MKCALENDAR', $calendarPath)['status']);
        $object = $calendarPath . self::uuid() . '.ics';
        $event = $this->event();
        self::assertSame(201, $this->request('PUT', $object, $event, ['Content-Type' => 'text/calendar'])['status']);
        $absentObject = '/calendars/' . $missing . '/' . $this->calendar . '/' . basename($object);
        foreach (['GET', 'PUT', 'DELETE', 'PROPFIND'] as $method) {
            $body = $method === 'PUT' ? $event : ($method === 'PROPFIND' ? $prop : '');
            $extra = $method === 'PUT' ? ['Content-Type' => 'text/calendar'] : ['Depth' => '0'];
            $denied = $this->request($method, $object, $body, $extra, $this->sign($method, $object, $this->b));
            $absent = $this->request($method, $absentObject, $body, $extra, $this->sign($method, $absentObject, $this->b));
            self::assertSame($absent['status'], $denied['status']);
            self::assertTrue($absent['body'] === $denied['body'], 'Other objects must be indistinguishable from absent objects');
        }
        foreach (['/principals/', '/calendars/'] as $root) {
            foreach ([$this->a, $this->b] as $id) {
                $r = $this->request('PROPFIND', $root, $prop, ['Depth' => '1'], $this->sign('PROPFIND', $root, $id));
                self::assertSame(207, $r['status']);
                self::assertTrue(!str_contains($r['body'], $id === $this->a ? $this->b : $this->a));
            }
        }
        foreach (['/principals/' . $this->a . '/?x=%2F&y=1', '/principals//' . $this->a . '/', '/principals%2F' . $this->a . '/', '/principals/' . $this->a . '/'] as $path) {
            self::assertSame(207, $this->request('PROPFIND', $path, $prop, ['Depth' => '0'])['status']);
        }
        $expired = Delegation::encode(random_bytes(16));
        $this->nonces[] = $expired;
        $q = $this->dav->prepare("INSERT INTO public.delegation_nonces VALUES (?, now() - interval '1 second')");
        $q->execute([$expired]);
        $this->request('PROPFIND', $target, $prop, ['Depth' => '0']);
        $q = $this->dav->prepare('SELECT count(*) FROM public.delegation_nonces WHERE nonce = ?');
        $q->execute([$expired]);
        self::assertSame(0, (int) $q->fetchColumn());
    }

    public function testDatabaseDenialReasons(): void
    {
        $nonce = Delegation::encode(random_bytes(16));
        $this->nonces[] = $nonce;
        self::assertSame('accepted', Delegation::accept($this->dav, ['p' => $this->a, 'n' => $nonce]));
        self::assertSame('replay', Delegation::accept($this->dav, ['p' => $this->a, 'n' => $nonce]));
        $unknownNonce = Delegation::encode(random_bytes(16));
        $this->nonces[] = $unknownNonce;
        self::assertSame('unknown_principal', Delegation::accept($this->dav, ['p' => self::uuid(), 'n' => $unknownNonce]));
        self::assertSame(1, $this->nonceCount());
    }

    public function testPublicHeaderIgnored(): void
    {
        $baseline = $this->request('GET', '/', '', [], '', true);
        self::assertSame(401, $baseline['status']);
        foreach ([$this->sign('GET', '/'), 'CALFLEX_REJECTED_HEADER_CANARY'] as $header) {
            $r = $this->request('GET', '/', '', [], $header, true);
            self::assertTrue($baseline === $r, 'Public responses must be byte-identical except Date');
        }
        self::assertSame(0, $this->nonceCount());
        self::assertSame(200, $this->request('GET', '/healthz', '', [], '', true)['status']);
    }

    private function event(): string
    {
        return \Calflex\Tests\EventFixture::create(self::uuid());
    }

    private function token(string $xml): string
    {
        $document = new \DOMDocument();
        self::assertTrue($document->loadXML($xml));
        $nodes = $document->getElementsByTagNameNS('DAV:', 'sync-token');
        self::assertSame(1, $nodes->length);
        return $nodes->item(0)->textContent;
    }

    /** @return array{status: int, headers: array<string, string>, body: string} */
    private function sync(string $path, string $token): array
    {
        $token = htmlspecialchars($token, ENT_XML1);
        return $this->request('REPORT', $path, '<d:sync-collection xmlns:d="DAV:"><d:sync-token>' . $token . '</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>');
    }

    public function testCalDavCrudRecurrenceAndSync(): void
    {
        $path = $this->home() . $this->calendar . '/';
        self::assertSame(201, $this->request('MKCALENDAR', $path)['status']);
        $home = $this->request('PROPFIND', $this->home(), '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', ['Depth' => '1']);
        self::assertSame(207, $home['status']);
        self::assertTrue(str_contains($home['body'], $this->calendar));
        $initial = $this->sync($path, '');
        self::assertSame(207, $initial['status']);
        $oldToken = $this->token($initial['body']);
        $object = $path . self::uuid() . '.ics';
        $event = $this->event();
        self::assertSame(201, $this->request('PUT', $object, $event, ['Content-Type' => 'text/calendar', 'If-None-Match' => '*'])['status']);
        $precondition = $this->request('PUT', $object, $event, ['Content-Type' => 'text/calendar', 'If-None-Match' => '*']);
        self::assertSame(412, $precondition['status']);
        self::assertSame('application/xml; charset=utf-8', $precondition['headers']['content-type']);
        $error = new \DOMDocument();
        self::assertTrue($error->loadXML($precondition['body']));
        self::assertSame('If-None-Match', $error->getElementsByTagNameNS('http://sabredav.org/ns', 'header')->item(0)?->textContent);
        self::assertSame(0, $error->getElementsByTagNameNS('http://sabredav.org/ns', 'message')->length);

        $get = $this->request('GET', $object);
        self::assertSame(200, $get['status']);
        self::assertTrue($get['body'] === $event, 'Calendar payload must round-trip');
        $etag = $get['headers']['etag'];
        self::assertSame(412, $this->request('PUT', $object, $event, ['Content-Type' => 'text/calendar', 'If-Match' => '"mismatch"'])['status']);
        self::assertSame(412, $this->request('GET', $object, '', ['If-Match' => '"mismatch"'])['status']);
        self::assertSame(304, $this->request('GET', $object, '', ['If-None-Match' => '*'])['status']);
        self::assertSame(204, $this->request('PUT', $object, $event, ['Content-Type' => 'text/calendar', 'If-Match' => $etag])['status']);
        $query = '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20261014T073000Z" end="20261014T093000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
        $result = $this->request('REPORT', $path, $query, ['Depth' => '1']);
        self::assertSame(207, $result['status']);
        self::assertTrue(str_contains($result['body'], $object), 'Recurring instance must match range away from master');
        $changed = $this->sync($path, $oldToken);
        self::assertSame(207, $changed['status']);
        self::assertTrue($this->token($changed['body']) !== $oldToken);
        self::assertTrue(str_contains($changed['body'], $object));
        self::assertSame(412, $this->request('DELETE', $object, '', ['If-Match' => '"mismatch"'])['status']);
        self::assertSame(204, $this->request('DELETE', $object, '', ['If-Match' => $etag])['status']);
        self::assertSame(404, $this->request('GET', $object)['status']);
    }
}
