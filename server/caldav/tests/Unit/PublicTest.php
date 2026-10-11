<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Tests\Signer;
use PHPUnit\Framework\TestCase;

final class PublicTest extends TestCase
{
    private const METHODS = ['GET', 'HEAD', 'OPTIONS', 'PROPFIND'];

    private const WELL_KNOWN = '/.well-known/caldav';

    /** The paths that are one character away from the discovery endpoint. */
    private const NEAR_MISSES = [
        '/.well-known/caldav/',
        '/.well-known/CALDAV',
        '/.well-known/CalDav',
        '/.well-known/caldavx',
        '/.well-known/carddav',
        '//.well-known/caldav',
        '/x/.well-known/caldav',
    ];

    public function testStandalonePublicEntry(): void
    {
        // Run the real entry in fresh PHP processes, including on an empty DB.
        foreach ([null, $this->delegation('GET', '/'), 'CALFLEX_REJECTED_HEADER_CANARY'] as $header) {
            self::assertSame(['status' => 401, 'body' => "Unauthorized\n"], $this->entry('GET', '/', $header));
        }
        self::assertSame(['status' => 200, 'body' => "ok\n"], $this->entry('GET', '/healthz'));
        self::assertSame(401, $this->entry('POST', '/healthz')['status']);
    }

    public function testWellKnownRedirectForEveryMethod(): void
    {
        foreach (self::METHODS as $method) {
            foreach ([null, $this->delegation($method, self::WELL_KNOWN), 'CALFLEX_REJECTED_HEADER_CANARY'] as $header) {
                self::assertSame(['status' => 301, 'body' => ''], $this->entry($method, self::WELL_KNOWN, $header));
                // A query string is ignored, never reflected.
                self::assertSame(['status' => 301, 'body' => ''], $this->entry($method, self::WELL_KNOWN . '?x=1', $header));
            }
        }
    }

    public function testNearMissPathsStayUnauthorized(): void
    {
        foreach (self::METHODS as $method) {
            foreach (self::NEAR_MISSES as $target) {
                self::assertSame(['status' => 401, 'body' => "Unauthorized\n"], $this->entry($method, $target), $method . ' ' . $target);
            }
        }
    }

    public function testRedirectOverHttp(): void
    {
        [$process, $pipes, $port] = $this->serve();
        try {
            $base = 'http://127.0.0.1:' . $port;
            foreach (self::METHODS as $method) {
                $responses = [];
                foreach ([null, $this->delegation($method, self::WELL_KNOWN), 'CALFLEX_REJECTED_HEADER_CANARY'] as $header) {
                    $response = $this->http($base . self::WELL_KNOWN . '?x=1', $method, $header);
                    self::assertSame(301, $response['status'], $method);
                    self::assertSame('/', $response['headers']['location'] ?? null, $method);
                    self::assertSame('no-store', $response['headers']['cache-control'] ?? null, $method);
                    self::assertArrayNotHasKey('server', $response['headers'], $method);
                    self::assertSame('', $response['body'], $method);
                    $responses[] = $response;
                }
                self::assertTrue($responses[0] === $responses[1] && $responses[1] === $responses[2], 'A delegation header must not change the response');
            }
            foreach (self::NEAR_MISSES as $target) {
                self::assertSame(401, $this->http($base . $target, 'PROPFIND', null)['status'], $target);
            }
            self::assertSame(200, $this->http($base . '/healthz', 'GET', null)['status']);
            // No open redirect: the target never comes from Host or a forwarded header.
            $hostHeaders = ['Host: evil.invalid', 'X-Forwarded-Host: evil.invalid', 'X-Forwarded-Proto: https'];
            $host = $this->http($base . self::WELL_KNOWN, 'GET', null, $hostHeaders);
            self::assertSame(301, $host['status']);
            self::assertSame('/', $host['headers']['location'] ?? null, 'The target must be the fixed service root');
        } finally {
            proc_terminate($process);
            foreach ($pipes as $pipe) {
                fclose($pipe);
            }
            proc_close($process);
        }
    }

    private function delegation(string $method, string $target): string
    {
        return Signer::header('test', str_repeat('a', 32), '8b0e189c-43a5-4f1e-a810-5c4b5c021593', $method, $target);
    }

    /**
     * The real entry, in a fresh process with a fake request environment.
     *
     * @return array{status: int, body: string}
     */
    private function entry(string $method, string $target, ?string $header = null): array
    {
        $server = ['REQUEST_METHOD' => $method, 'REQUEST_URI' => $target];
        if (null !== $header) {
            $server['HTTP_X_CALFLEX_PRINCIPAL'] = $header;
        }
        $code = '$_SERVER = ' . var_export($server, true) . ';'
            . ' ob_start(); require ' . var_export(dirname(__DIR__, 2) . '/public/index.php', true) . ';'
            . ' $body = ob_get_clean();'
            . ' $status = http_response_code();'
            . ' echo json_encode(["status" => false === $status ? 200 : $status, "body" => $body]);';
        $process = proc_open([PHP_BINARY, '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        self::assertIsResource($process);
        $out = (string) stream_get_contents($pipes[1]);
        $err = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        self::assertSame(0, proc_close($process));
        self::assertSame('', $err, 'Standalone public entry must produce no logs');
        $decoded = json_decode($out, true);
        if (!is_array($decoded) || !isset($decoded['status'], $decoded['body'])) {
            self::fail('The public entry produced no response: ' . $out);
        }

        return ['status' => (int) $decoded['status'], 'body' => (string) $decoded['body']];
    }

    /**
     * The same entry behind a web server, so response headers are real.
     *
     * @return array{0: resource, 1: array<int, resource>, 2: int}
     */
    private function serve(): array
    {
        $directory = dirname(__DIR__, 2);
        $listener = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
        self::assertIsResource($listener, $error);
        $name = (string) stream_socket_get_name($listener, false);
        fclose($listener);
        $port = (int) substr($name, (int) strrpos($name, ':') + 1);
        $process = proc_open(
            [PHP_BINARY, '-d', 'expose_php=Off', '-S', '127.0.0.1:' . $port, $directory . '/public/index.php'],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            $directory
        );
        self::assertIsResource($process);
        for ($attempt = 0; $attempt < 200; ++$attempt) {
            $socket = @fsockopen('127.0.0.1', $port, $errno, $error, 0.1);
            if (false !== $socket) {
                fclose($socket);

                return [$process, $pipes, $port];
            }
            usleep(25000);
        }
        proc_terminate($process);
        self::fail('The built-in server did not start on port ' . $port);
    }

    /**
     * @param list<string> $extra raw header lines to send as-is
     * @return array{status: int, headers: array<string, string>, body: string}
     */
    private function http(string $url, string $method, ?string $header, array $extra = []): array
    {
        $lines = array_merge(['Connection: close'], $extra);
        if (null !== $header) {
            $lines[] = 'X-Calflex-Principal: ' . $header;
        }
        $context = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $lines), 'ignore_errors' => true, 'follow_location' => 0, 'timeout' => 10]]);
        $body = @file_get_contents($url, false, $context);
        self::assertNotFalse($body, 'Request to the built-in server failed: ' . $method . ' ' . $url);
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

        return ['status' => (int) ($status[1] ?? 0), 'headers' => $headers, 'body' => $body];
    }
}
