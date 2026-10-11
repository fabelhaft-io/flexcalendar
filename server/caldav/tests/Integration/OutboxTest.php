<?php

declare(strict_types=1);

namespace Calflex\Tests\Integration;

use Calflex\Database;
use Calflex\Delegation;
use Calflex\GuardedCalendars;
use Calflex\Tests\EventFixture;
use Calflex\Tests\GuardCases;
use Calflex\Tests\Signer;
use Calflex\Tests\ThrowingCalendars;
use Calflex\WriteGuard;
use PHPUnit\Framework\TestCase;

final class OutboxTest extends TestCase
{
    private const SYNCTOKEN_PREFIX = 'http://sabre.io/ns/sync/';
    private const PRECONDITION_NS = 'https://flexcalendar.de/ns/caldav';

    private \PDO $api;
    private \PDO $dav;
    private string $a;
    private string $b;
    private string $calendar;
    private string $keyId;
    private string $key;
    private int $sabreCalendar = 0;
    private int $sabreInstance = 0;
    /** @var list<string> */
    private array $nonces = [];
    /** @var list<string> */
    private array $extraCollections = [];
    /** @var list<string> */
    private array $tempFiles = [];
    /** @var list<string> */
    private array $tempDirs = [];

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
        foreach ($this->tempFiles as $file) {
            @unlink($file);
        }
        foreach ($this->tempDirs as $dir) {
            foreach ((array) glob($dir . '/*') as $file) {
                @unlink((string) $file);
            }
            @rmdir($dir);
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
        ksort($headers);
        return ['status' => (int) ($status[1] ?? 0), 'headers' => $headers, 'body' => (string) $response];
    }

    private function token(string $xml): string
    {
        $document = new \DOMDocument();
        self::assertTrue($document->loadXML($xml));
        $nodes = $document->getElementsByTagNameNS('DAV:', 'sync-token');
        self::assertSame(1, $nodes->length);
        return $nodes->item(0)->textContent;
    }

    private function tokenNumber(string $xml): int
    {
        $token = $this->token($xml);
        self::assertStringStartsWith(self::SYNCTOKEN_PREFIX, $token);
        return (int) substr($token, strlen(self::SYNCTOKEN_PREFIX));
    }

    /** @return array{status: int, headers: array<string, string>, body: string} */
    private function sync(string $path, string $token): array
    {
        $token = htmlspecialchars($token, ENT_XML1);
        return $this->request('REPORT', $path, '<d:sync-collection xmlns:d="DAV:"><d:sync-token>' . $token . '</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>');
    }

    /** MKCALENDAR the fixture calendar and remember its SabreDAV ids. */
    private function collection(): string
    {
        $path = $this->home() . $this->calendar . '/';
        self::assertSame(201, $this->request('MKCALENDAR', $path)['status']);
        $query = $this->dav->prepare('SELECT i.calendarid, i.id FROM sabredav.calendarinstances i WHERE i.uri = ?');
        $query->execute([$this->calendar]);
        $row = $query->fetch(\PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            self::fail('SabreDAV calendar instance row is missing');
        }
        $this->sabreCalendar = (int) $row['calendarid'];
        $this->sabreInstance = (int) $row['id'];
        return $path;
    }

    /** @return array{calendar: int, instance: int} */
    private function ids(): array
    {
        return ['calendar' => $this->sabreCalendar, 'instance' => $this->sabreInstance];
    }

    private function synctoken(): int
    {
        $query = $this->dav->prepare('SELECT synctoken FROM sabredav.calendars WHERE id = ?');
        $query->execute([$this->sabreCalendar]);
        return (int) $query->fetchColumn();
    }

    private function objectCount(string $uri): int
    {
        $query = $this->dav->prepare('SELECT count(*) FROM sabredav.calendarobjects WHERE calendarid = ? AND uri = ?');
        $query->execute([$this->sabreCalendar, $uri]);
        return (int) $query->fetchColumn();
    }

    /** @return array{etag: string, uid: string, size: int, digest: string}|null */
    private function objectRow(string $uri): ?array
    {
        $query = $this->dav->prepare('SELECT etag, uid, size, md5(calendardata) AS digest FROM sabredav.calendarobjects WHERE calendarid = ? AND uri = ?');
        $query->execute([$this->sabreCalendar, $uri]);
        $row = $query->fetch(\PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }
        return ['etag' => (string) $row['etag'], 'uid' => (string) $row['uid'], 'size' => (int) $row['size'], 'digest' => (string) $row['digest']];
    }

    private function changeCount(): int
    {
        $query = $this->dav->prepare('SELECT count(*) FROM sabredav.calendarchanges WHERE calendarid = ?');
        $query->execute([$this->sabreCalendar]);
        return (int) $query->fetchColumn();
    }

    /** The SabreDAV change row's token for the object with this UID. */
    private function changeToken(string $uid): int
    {
        $query = $this->dav->prepare('SELECT c.synctoken FROM sabredav.calendarchanges c JOIN sabredav.calendarobjects o ON o.calendarid = c.calendarid AND o.uri = c.uri WHERE c.calendarid = ? AND o.uid = ?');
        $query->execute([$this->sabreCalendar, $uid]);
        return (int) $query->fetchColumn();
    }

    /** @return list<array{calendar_id: string, sync_token: string, uid: string, change_type: string}> */
    private function outbox(): array
    {
        $query = $this->dav->prepare('SELECT calendar_id, sync_token, uid, change_type FROM public.caldav_changes WHERE calendar_id = ? ORDER BY sync_token');
        $query->execute([$this->calendar]);
        /** @var list<array{calendar_id: string, sync_token: string, uid: string, change_type: string}> $rows */
        $rows = $query->fetchAll(\PDO::FETCH_ASSOC);
        return $rows;
    }

    private function outboxCount(): int
    {
        return count($this->outbox());
    }

    private function reportedToken(string $path, int $token, string $object): int
    {
        $report = $this->sync($path, self::SYNCTOKEN_PREFIX . $token);
        self::assertSame(207, $report['status']);
        self::assertTrue(str_contains($report['body'], $object), 'sync-collection must list the changed object');
        return $this->tokenNumber($report['body']);
    }

    private function assertChange(string $uid, string $type, int $token): void
    {
        $rows = $this->outbox();
        $row = $rows === [] ? null : $rows[count($rows) - 1];
        self::assertNotNull($row, 'Missing caldav_changes row');
        self::assertSame($this->calendar, $row['calendar_id']);
        self::assertSame($uid, $row['uid']);
        self::assertSame($type, $row['change_type']);
        self::assertSame($token, (int) $row['sync_token']);
    }

    /**
     * @param array{process: resource, pipes: array<int, resource>} $child
     * @return array{signaled: bool, termsig: int, exitcode: int, output: string}
     */
    private function wait(array $child): array
    {
        $deadline = microtime(true) + 30.0;
        $status = proc_get_status($child['process']);
        while ($status['running']) {
            if (microtime(true) > $deadline) {
                proc_terminate($child['process'], 9);
                self::fail('Writer process timed out');
            }
            usleep(5000);
            $status = proc_get_status($child['process']);
        }
        $output = (string) stream_get_contents($child['pipes'][1]);
        $errors = (string) stream_get_contents($child['pipes'][2]);
        fclose($child['pipes'][1]);
        fclose($child['pipes'][2]);
        proc_close($child['process']);
        return [
            'signaled' => (bool) $status['signaled'],
            'termsig' => (int) $status['termsig'],
            'exitcode' => (int) $status['exitcode'],
            'output' => $output . $errors,
        ];
    }

    /**
     * @param array<string, mixed> $config
     * @return array{process: resource, pipes: array<int, resource>}
     */
    private function start(array $config): array
    {
        $file = tempnam(sys_get_temp_dir(), 'calflex-outbox');
        if ($file === false) {
            self::fail('Could not create the writer configuration file');
        }
        $this->tempFiles[] = $file;
        file_put_contents($file, json_encode($config, JSON_THROW_ON_ERROR));
        $pipes = [];
        $process = proc_open([PHP_BINARY, dirname(__DIR__) . '/OutboxWriter.php', $file], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($process)) {
            self::fail('Could not start the writer process');
        }
        return ['process' => $process, 'pipes' => $pipes];
    }

    /** @param array{calendar: int, instance: int} $ids
     * @param array{dir: string, index: int, count: int}|null $barrier
     * @return array<string, mixed>
     */
    private function config(array $ids, string $mode, bool $kill, string $uri, string $payload, ?array $barrier = null): array
    {
        $config = [
            'mode' => $mode,
            'kill' => $kill,
            'calendar' => $ids['calendar'],
            'instance' => $ids['instance'],
            'uri' => $uri,
            'payload' => base64_encode($payload),
        ];
        if ($barrier !== null) {
            $config['barrier'] = $barrier;
        }
        return $config;
    }

    /** @param array{calendar: int, instance: int} $ids
     * @return array{signaled: bool, termsig: int, exitcode: int, output: string}
     */
    private function writer(array $ids, string $mode, bool $kill, string $uri, string $payload): array
    {
        return $this->wait($this->start($this->config($ids, $mode, $kill, $uri, $payload)));
    }

    /** @param array{signaled: bool, termsig: int, exitcode: int, output: string} $child */
    private function assertKilled(array $child): void
    {
        self::assertTrue($child['signaled'], 'Writer must die of a signal: ' . $child['output']);
        self::assertSame(9, $child['termsig']);
    }

    /** @param array{signaled: bool, termsig: int, exitcode: int, output: string} $child */
    private function assertCompleted(array $child): void
    {
        self::assertFalse($child['signaled'], 'Writer must exit cleanly: ' . $child['output']);
        self::assertSame(0, $child['exitcode'], 'Writer failed: ' . $child['output']);
    }

    private function assertState(int $objects, int $changes, int $outbox, int $token, string $uri): void
    {
        self::assertSame($objects, $this->objectCount($uri), 'Unexpected calendarobjects rows');
        self::assertSame($changes, $this->changeCount(), 'Unexpected calendarchanges rows');
        self::assertSame($outbox, $this->outboxCount(), 'Unexpected caldav_changes rows');
        self::assertSame($token, $this->synctoken(), 'Unexpected calendars.synctoken');
    }

    /**
     * A failing object write must close its own transaction on the test's own
     * connection and propagate the failure, leaving no object, change or outbox row.
     */
    private function assertRolledBack(\Closure $write): void
    {
        $raised = null;
        try {
            $write();
        } catch (\RuntimeException $exception) {
            $raised = $exception;
        }
        self::assertNotNull($raised, 'A failing object write must propagate its exception');
        self::assertSame('afterObjectWrite failed', $raised->getMessage());
        self::assertFalse($this->dav->inTransaction(), 'A failed object write must roll its transaction back');
    }

    /**
     * Run one writer with the kill seam on, and assert what its open transaction
     * saw between the object write and the outbox insert: a transaction is open,
     * SabreDAV's change row is in it, and the outbox row is not. The seam must
     * report from inside the transaction and the process must die of SIGKILL.
     *
     * @param array{calendar: int, instance: int} $ids
     * @return array{object: bool, etag: ?string, changes: int, outbox: int, transaction: bool}
     */
    private function killedBetweenWrites(array $ids, string $mode, string $uri, string $payload): array
    {
        $changes = $this->changeCount();
        $outbox = $this->outboxCount();
        $child = $this->writer($ids, $mode, true, $uri, $payload);
        $this->assertKilled($child);
        $state = $this->seam($child);
        self::assertTrue($state['transaction'], 'The kill seam must run inside the write transaction');
        self::assertSame($changes + 1, $state['changes'], 'The transaction must hold the sabredav.calendarchanges row');
        self::assertSame($outbox, $state['outbox'], 'The outbox row must not exist yet inside the transaction');
        return $state;
    }

    /**
     * The one state line the kill seam prints before it dies, from the writer's own
     * connection. It carries no event content: counts, the object URI and the etag.
     *
     * @param array{signaled: bool, termsig: int, exitcode: int, output: string} $child
     * @return array{object: bool, etag: ?string, changes: int, outbox: int, transaction: bool}
     */
    private function seam(array $child): array
    {
        self::assertSame(1, preg_match('/\ASEAM (\{.*\})$/m', $child['output'], $matches), 'The kill seam must report one state line: ' . $child['output']);
        $state = json_decode($matches[1], true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($state);
        $etag = $state['etag'] ?? null;
        $changes = $state['changes'] ?? null;
        $outbox = $state['outbox'] ?? null;
        return [
            'object' => ($state['object'] ?? null) === true,
            'etag' => is_string($etag) ? $etag : null,
            'changes' => is_int($changes) ? $changes : -1,
            'outbox' => is_int($outbox) ? $outbox : -1,
            'transaction' => ($state['transaction'] ?? null) === true,
        ];
    }

    private static function payload(string $uid): string
    {
        return str_replace('UID:adf46a78-3c92-4c1e-ab04-7f791296e61e', 'UID:' . $uid, GuardCases::skeleton());
    }

    public function testOutboxRecordsEachChangeWithTheReportedToken(): void
    {
        $path = $this->collection();
        $uid = self::uuid();
        $object = $path . self::uuid() . '.ics';
        $token = $this->tokenNumber($this->sync($path, '')['body']);
        self::assertGreaterThan(0, $token);

        // create
        $event = EventFixture::create($uid);
        self::assertSame(201, $this->request('PUT', $object, $event, ['Content-Type' => 'text/calendar', 'If-None-Match' => '*'])['status']);
        $this->assertChange($uid, 'created', ++$token);
        self::assertSame($token, $this->reportedToken($path, $token - 1, $object));

        // a failing precondition is not a change
        $get = $this->request('GET', $object);
        self::assertSame(200, $get['status']);
        self::assertSame(412, $this->request('PUT', $object, $event, ['Content-Type' => 'text/calendar', 'If-Match' => '"mismatch"'])['status']);
        self::assertSame(1, $this->outboxCount());

        // update
        $changed = str_replace(str_repeat('a', 64), str_repeat('b', 64), $get['body']);
        self::assertSame(204, $this->request('PUT', $object, $changed, ['Content-Type' => 'text/calendar', 'If-Match' => $get['headers']['etag']])['status']);
        $this->assertChange($uid, 'updated', ++$token);
        self::assertSame($token, $this->reportedToken($path, $token - 1, $object));

        // delete
        self::assertSame(204, $this->request('DELETE', $object)['status']);
        $this->assertChange($uid, 'deleted', ++$token);
        self::assertSame($token, $this->reportedToken($path, $token - 1, $object));
        self::assertSame(3, $this->outboxCount());
    }

    public function testProcessKillLeavesNeitherObjectNorOutbox(): void
    {
        $this->collection();
        $ids = $this->ids();
        $token = $this->synctoken();
        $uid = self::uuid();
        $uri = self::uuid() . '.ics';
        $payload = self::payload($uid);

        // A create killed in the seam: the writer's transaction already holds the
        // object and SabreDAV's change row, the outbox row is not written yet, and
        // the process dies before the commit, so a second connection sees neither.
        $seam = $this->killedBetweenWrites($ids, 'create', $uri, $payload);
        self::assertTrue($seam['object'], 'The kill seam must run after the object write');
        self::assertNotNull($seam['etag']);
        $this->assertState(0, 0, 0, $token, $uri);

        // The same create without the kill writes all four.
        $this->assertCompleted($this->writer($ids, 'create', false, $uri, $payload));
        $this->assertState(1, 1, 1, ++$token, $uri);
        $this->assertChange($uid, 'created', $token);
        $created = $this->objectRow($uri);
        self::assertNotNull($created);
        self::assertSame($created['etag'], $seam['etag'], 'The killed create staged the bytes the committed create stored');

        // An update killed in the seam already replaced the stored bytes and etag
        // in its transaction, still without an outbox row, and rolls back on the kill.
        $updated = str_replace(str_repeat('a', 64), str_repeat('b', 64), $payload);
        $seam = $this->killedBetweenWrites($ids, 'update', $uri, $updated);
        self::assertTrue($seam['object'], 'The kill seam must run after the object write');
        self::assertNotSame($created['etag'], $seam['etag'], 'The kill seam must see the new bytes, not the old ones');
        $this->assertState(1, 1, 1, $token, $uri);
        self::assertSame($created, $this->objectRow($uri));

        // The same update without the kill replaces the object and records it.
        $this->assertCompleted($this->writer($ids, 'update', false, $uri, $updated));
        $this->assertState(1, 2, 2, ++$token, $uri);
        $this->assertChange($uid, 'updated', $token);
        $current = $this->objectRow($uri);
        self::assertNotNull($current);
        self::assertNotSame($created, $current);
        self::assertSame($current['etag'], $seam['etag'], 'The killed update staged the bytes the committed update stored');

        // A delete killed in the seam already removed the object in its
        // transaction, still without an outbox row, and rolls back on the kill.
        $seam = $this->killedBetweenWrites($ids, 'delete', $uri, '');
        self::assertFalse($seam['object'], 'The kill seam must run after the object row is gone');
        self::assertNull($seam['etag']);
        $this->assertState(1, 2, 2, $token, $uri);
        self::assertSame($current, $this->objectRow($uri));

        // The same delete without the kill removes it and records the change.
        $this->assertCompleted($this->writer($ids, 'delete', false, $uri, ''));
        $this->assertState(0, 3, 3, ++$token, $uri);
        $this->assertChange($uid, 'deleted', $token);
    }

    public function testNestedTransactionIsRefusedWithoutWriting(): void
    {
        $this->collection();
        $token = $this->synctoken();
        $uri = self::uuid() . '.ics';
        $payload = self::payload(self::uuid());
        $backend = new GuardedCalendars($this->dav, WriteGuard::fromPdo($this->dav));

        $this->dav->beginTransaction();
        try {
            $raised = null;
            try {
                $backend->createCalendarObject([$this->sabreCalendar, $this->sabreInstance], $uri, $payload);
            } catch (\RuntimeException $exception) {
                $raised = $exception;
            }
            self::assertNotNull($raised, 'An object write on an open transaction must be refused');
            self::assertSame('CalDAV object writes must not nest transactions', $raised->getMessage());
            self::assertTrue($this->dav->inTransaction(), 'The refusal must leave the caller transaction alone');
            $this->assertState(0, 0, 0, $token, $uri);
        } finally {
            if ($this->dav->inTransaction()) {
                $this->dav->rollBack();
            }
        }
    }

    public function testWriteFailureRollsBackTheTransaction(): void
    {
        $this->collection();
        $ids = $this->ids();
        $token = $this->synctoken();
        $uri = self::uuid() . '.ics';
        $payload = self::payload(self::uuid());
        $calendarId = [$this->sabreCalendar, $this->sabreInstance];
        $backend = new ThrowingCalendars($this->dav, WriteGuard::fromPdo($this->dav));

        $this->assertRolledBack(function () use ($backend, $calendarId, $uri, $payload): void {
            $backend->createCalendarObject($calendarId, $uri, $payload);
        });
        $this->assertState(0, 0, 0, $token, $uri);

        // A committed create gives the update and the delete something to work on.
        $this->assertCompleted($this->writer($ids, 'create', false, $uri, $payload));
        $this->assertState(1, 1, 1, ++$token, $uri);
        $created = $this->objectRow($uri);
        self::assertNotNull($created);

        $changed = str_replace(str_repeat('a', 64), str_repeat('b', 64), $payload);
        $this->assertRolledBack(function () use ($backend, $calendarId, $uri, $changed): void {
            $backend->updateCalendarObject($calendarId, $uri, $changed);
        });
        $this->assertState(1, 1, 1, $token, $uri);
        self::assertSame($created, $this->objectRow($uri));

        $this->assertRolledBack(function () use ($backend, $calendarId, $uri): void {
            $backend->deleteCalendarObject($calendarId, $uri);
        });
        $this->assertState(1, 1, 1, $token, $uri);
        self::assertSame($created, $this->objectRow($uri));
    }

    public function testConcurrentWritersGetDistinctTokens(): void
    {
        $this->collection();
        $ids = $this->ids();
        $base = $this->synctoken();
        $dir = $this->barrierDir();
        $children = [];
        for ($i = 0; $i < 4; ++$i) {
            $uid = self::uuid();
            $children[] = $this->start($this->config($ids, 'create', false, self::uuid() . '.ics', self::payload($uid), ['dir' => $dir, 'index' => $i, 'count' => 4]));
        }
        foreach ($children as $child) {
            $this->assertCompleted($this->wait($child));
        }

        $tokens = [];
        foreach ($this->outbox() as $row) {
            $tokens[] = (int) $row['sync_token'];
            self::assertSame((int) $row['sync_token'], $this->changeToken($row['uid']) + 1, 'Outbox token must be the reported token');
        }
        self::assertSame(range($base + 1, $base + 4), $tokens, 'Concurrent writes must not share a sync token');
        self::assertSame(max($tokens), $this->synctoken());
        self::assertSame(4, $this->changeCount());
    }

    public function testWriteIntoUnregisteredCollectionIsRefused(): void
    {
        $uuid = self::uuid();
        $path = $this->home() . $uuid . '/';
        $this->extraCollections[] = $path;
        self::assertSame(201, $this->request('MKCALENDAR', $path)['status']);
        $object = $path . self::uuid() . '.ics';

        $response = $this->request('PUT', $object, self::payload(self::uuid()), ['Content-Type' => 'text/calendar']);
        self::assertSame(403, $response['status']);
        $xml = new \DOMDocument();
        self::assertTrue($xml->loadXML($response['body']));
        self::assertSame('DAV:', $xml->documentElement->namespaceURI);
        self::assertSame('error', $xml->documentElement->localName);
        self::assertSame(1, $xml->getElementsByTagNameNS(self::PRECONDITION_NS, 'unmapped-collection')->length);
        self::assertSame(0, $xml->getElementsByTagNameNS('http://sabredav.org/ns', 'message')->length);
        self::assertSame(0, $xml->getElementsByTagNameNS('http://sabredav.org/ns', 'exception')->length);

        $query = $this->dav->prepare('SELECT count(*) FROM sabredav.calendarobjects WHERE calendarid = (SELECT i.calendarid FROM sabredav.calendarinstances i WHERE i.uri = ?)');
        $query->execute([$uuid]);
        self::assertSame(0, (int) $query->fetchColumn());
        $query = $this->dav->prepare('SELECT count(*) FROM sabredav.calendarchanges WHERE calendarid = (SELECT i.calendarid FROM sabredav.calendarinstances i WHERE i.uri = ?)');
        $query->execute([$uuid]);
        self::assertSame(0, (int) $query->fetchColumn());
        $query = $this->dav->prepare('SELECT count(*) FROM public.caldav_changes WHERE calendar_id = ?');
        $query->execute([$uuid]);
        self::assertSame(0, (int) $query->fetchColumn());
    }

    private function barrierDir(): string
    {
        $dir = sys_get_temp_dir() . '/calflex-outbox-' . bin2hex(random_bytes(8));
        if (!mkdir($dir) && !is_dir($dir)) {
            self::fail('Could not create the writer barrier directory');
        }
        $this->tempDirs[] = $dir;
        return $dir;
    }
}
