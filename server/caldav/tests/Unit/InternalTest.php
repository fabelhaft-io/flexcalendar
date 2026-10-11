<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Tests\Signer;
use PHPUnit\Framework\TestCase;

final class InternalTest extends TestCase
{
    public function testFixedDenialAndRequestLogs(): void
    {
        $key = str_repeat('a', 32);
        $valid = Signer::header('test', $key, '8b0e189c-43a5-4f1e-a810-5c4b5c021593', 'GET', '/');
        $id = '11111111-2222-4333-8444-555555555555';
        foreach ([
            ['test:' . base64_encode($key), '', ['HTTP_X_REQUEST_ID' => $id], 'GET', 'GET', 'delegation_denied malformed', $id],
            ['test:' . base64_encode($key), 'REJECTED_HEADER_CANARY', [], 'GET', 'GET', 'delegation_denied malformed', '-'],
            ['test:' . base64_encode($key), str_replace('k=test', 'k=unknown', $valid), [], 'GET', 'GET', 'delegation_denied unknown_key', '-'],
            ['', $valid, [], 'GET', 'GET', 'delegation_error', '-'],
            // A valid signature reaches the database, whose configuration fails.
            ['test:' . base64_encode($key), $valid, ['HTTP_X_REQUEST_ID' => $id], 'GET', 'GET', 'delegation_error', $id],
            // Only a method from the fixed allow-list is ever logged.
            ['test:' . base64_encode($key), 'CALFLEX_GUARD_MARKER', [], 'CALFLEX_GUARD_MARKER', 'OTHER', 'delegation_denied malformed', '-'],
        ] as [$config, $header, $extra, $method, $loggedMethod, $reason, $loggedId]) {
            $entry = dirname(__DIR__, 2) . '/internal/index.php';
            $code = 'putenv(' . var_export('CALFLEX_DELEGATION_KEYS=' . $config, true) . ');'
                . 'putenv("CALFLEX_DATABASE_URL=invalid");'
                . '$_SERVER = ' . var_export([
                    'REQUEST_METHOD' => $method,
                    'REQUEST_URI' => '/',
                    'HTTP_X_CALFLEX_PRINCIPAL' => $header,
                ] + $extra, true) . ';'
                . 'require ' . var_export($entry, true) . '; echo http_response_code();';
            $process = proc_open([PHP_BINARY, '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            self::assertIsResource($process);
            $out = stream_get_contents($pipes[1]);
            $err = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            self::assertSame(0, proc_close($process));
            self::assertTrue($out === "Unauthorized\n401", 'Denial response must remain fixed');
            // Two fixed lines: the reason, then the access line. Neither holds a
            // path, a header value or a body, and the ID is the API's or `-`.
            $expected = 'caldav ' . $reason . ' ' . $loggedId . "\n"
                . 'caldav request ' . $loggedMethod . ' 401 ' . $loggedId . "\n";
            self::assertTrue($err === $expected, 'Logs must contain only the fixed lines');
        }
    }

    public function testCorrelationIdMustBeAUuidV4(): void
    {
        foreach ([
            ['11111111-2222-4333-8444-555555555555', true],
            // Uppercase, wrong version, wrong variant, a trailing byte and free text.
            ['11111111-2222-4333-8444-55555555555A', false],
            ['11111111-2222-3333-8444-555555555555', false],
            ['11111111-2222-4333-0444-555555555555', false],
            ['11111111-2222-4333-8444-555555555555 x', false],
            ['CALFLEX_REJECTED_BODY_CANARY', false],
        ] as [$value, $accepted]) {
            $entry = dirname(__DIR__, 2) . '/internal/index.php';
            $code = 'putenv("CALFLEX_DELEGATION_KEYS=");'
                . 'putenv("CALFLEX_DATABASE_URL=invalid");'
                . '$_SERVER = ' . var_export([
                    'REQUEST_METHOD' => 'GET',
                    'REQUEST_URI' => '/',
                    'HTTP_X_REQUEST_ID' => $value,
                ], true) . ';'
                . 'require ' . var_export($entry, true) . ';';
            $process = proc_open([PHP_BINARY, '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            self::assertIsResource($process);
            $err = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            self::assertSame(0, proc_close($process));
            $expected = $accepted ? $value : '-';
            self::assertStringEndsWith(' ' . $expected . "\n", $err, $value);
            if (!$accepted) {
                self::assertStringNotContainsString($value, $err, 'An invalid ID must not be logged');
            }
        }
    }
}
