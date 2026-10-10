<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Tests\Signer;
use PHPUnit\Framework\TestCase;

final class InternalTest extends TestCase
{
    public function testFixedDenialAndErrorLogs(): void
    {
        $key = str_repeat('a', 32);
        $valid = Signer::header('test', $key, '8b0e189c-43a5-4f1e-a810-5c4b5c021593', 'GET', '/');
        foreach ([
            ['test:' . base64_encode($key), '', 'delegation_denied malformed'],
            ['test:' . base64_encode($key), 'REJECTED_HEADER_CANARY', 'delegation_denied malformed'],
            ['test:' . base64_encode($key), str_replace('k=test', 'k=unknown', $valid), 'delegation_denied unknown_key'],
            ['', $valid, 'delegation_error'],
            // A valid signature reaches the database, whose configuration fails.
            ['test:' . base64_encode($key), $valid, 'delegation_error'],
        ] as [$config, $header, $reason]) {
            $entry = dirname(__DIR__, 2) . '/internal/index.php';
            $code = 'putenv(' . var_export('CALFLEX_DELEGATION_KEYS=' . $config, true) . ');'
                . 'putenv("CALFLEX_DATABASE_URL=invalid");'
                . '$_SERVER = ' . var_export(['REQUEST_METHOD' => 'GET', 'REQUEST_URI' => '/', 'HTTP_X_CALFLEX_PRINCIPAL' => $header], true) . ';'
                . 'require ' . var_export($entry, true) . '; echo http_response_code();';
            $process = proc_open([PHP_BINARY, '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            self::assertIsResource($process);
            $out = stream_get_contents($pipes[1]);
            $err = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            self::assertSame(0, proc_close($process));
            self::assertTrue($out === "Unauthorized\n401", 'Denial response must remain fixed');
            self::assertTrue($err === 'caldav ' . $reason . "\n", 'Logs must contain only a fixed reason code');
        }
    }
}
