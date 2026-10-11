<?php

declare(strict_types=1);

namespace Calflex\Tests\Integration;

use Calflex\Database;
use Calflex\Delegation;
use Calflex\Tests\Multistatus;
use Calflex\Tests\Signer;
use PHPUnit\Framework\TestCase;

/**
 * E03-R02 — the discovery sequence stock apps run before they sync anything.
 *
 * The hrefs follow the runtime layout: the tree root hands out the principal,
 * the principal names itself and its calendar home, and the home lists the
 * collections. Every href is compared whole; a wrong value has to fail, so run
 * this file once with the expected string in testDiscoverySequence hand-edited
 * to prove it (E03-R02 review, run 1).
 */
final class DiscoveryTest extends TestCase
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
        $q->execute([$this->calendar, $this->a, $this->home() . $this->calendar . '/']);
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

    private function principal(): string
    {
        return '/principals/' . $this->a . '/';
    }

    private function sign(string $method, string $target, ?string $principal = null): string
    {
        $nonce = Delegation::encode(random_bytes(16));
        $this->nonces[] = $nonce;
        return Signer::header($this->keyId, $this->key, $principal ?? $this->a, $method, $target, null, $nonce);
    }

    /**
     * The Accept criterion: the three PROPFINDs a stock app makes, over the
     * internal listener, as a delegated principal.
     */
    public function testDiscoverySequence(): void
    {
        $collection = $this->home() . $this->calendar . '/';
        self::assertSame(201, $this->request('MKCALENDAR', $collection)['status']);

        // 1. The tree root names the acting principal.
        $root = $this->request('PROPFIND', '/', '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', ['Depth' => '0']);
        self::assertSame(207, $root['status']);
        self::assertSame($this->principal(), Multistatus::propertyHref($root['body'], Multistatus::DAV, 'current-user-principal'));

        // 2. The principal names itself and its calendar home.
        $principal = $this->request('PROPFIND', $this->principal(), '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:principal-URL/><c:calendar-home-set/></d:prop></d:propfind>', ['Depth' => '0']);
        self::assertSame(207, $principal['status']);
        self::assertSame($this->principal(), Multistatus::propertyHref($principal['body'], Multistatus::DAV, 'principal-URL'));
        self::assertSame($this->home(), Multistatus::propertyHref($principal['body'], Multistatus::CALDAV, 'calendar-home-set'));

        // 3. The home lists the calendar to sync.
        $listing = $this->request('PROPFIND', $this->home(), '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', ['Depth' => '1']);
        self::assertSame(207, $listing['status']);
        $hrefs = Multistatus::responseHrefs($listing['body']);
        self::assertSame(1, count(array_keys($hrefs, $collection, true)), 'The calendar must be listed exactly once');
        self::assertContains($this->home(), $hrefs, 'The home itself is part of a Depth-1 listing');
    }

    /**
     * The same redirect on the public listener, without authentication.
     *
     * A deployment test: Phase 4 re-runs this with a device app password, and
     * E15-R05 checks what the stock apps themselves make of it.
     */
    public function testWellKnownRedirectOnThePublicListener(): void
    {
        $baseline = $this->request('GET', '/.well-known/caldav', '', [], '', true);
        self::assertSame(301, $baseline['status']);
        self::assertSame('/', $baseline['headers']['location']);
        self::assertSame('no-store', $baseline['headers']['cache-control']);
        self::assertSame('', $baseline['body']);
        foreach (['CALFLEX_REJECTED_HEADER_CANARY', $this->sign('GET', '/.well-known/caldav')] as $header) {
            self::assertTrue($baseline === $this->request('GET', '/.well-known/caldav', '', [], $header, true), 'A delegation header must not change the redirect');
        }
        self::assertSame(301, $this->request('GET', '/.well-known/caldav?x=1', '', [], '', true)['status'], 'A query string is ignored');
        foreach (['/.well-known/caldav/', '/.well-known/CALDAV', '/.well-known/caldavx', '/.well-known/carddav', '//.well-known/caldav', '/x/.well-known/caldav', '/.well-known'] as $target) {
            self::assertSame(401, $this->request('GET', $target, '', [], '', true)['status'], $target);
        }
        // Still no database: a signed header that is never authenticated elsewhere
        // must not have consumed its nonce.
        self::assertSame(0, $this->nonceCount());
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
                if ('date' !== strtolower($name)) {
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
}
