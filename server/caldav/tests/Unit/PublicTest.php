<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use PHPUnit\Framework\TestCase;

final class PublicTest extends TestCase
{
    public function testStandalonePublicEntry(): void
    {
        // Run the real entry in fresh PHP processes, including on an empty DB.
        $entry = dirname(__DIR__, 2) . '/public/index.php';
        foreach ([null, \Calflex\Tests\Signer::header('test', str_repeat('a', 32), '8b0e189c-43a5-4f1e-a810-5c4b5c021593', 'GET', '/'), 'CALFLEX_REJECTED_HEADER_CANARY'] as $header) {
            $server = ['REQUEST_METHOD' => 'GET', 'REQUEST_URI' => '/'];
            if ($header !== null) {
                $server['HTTP_X_CALFLEX_PRINCIPAL'] = $header;
            }
            $code = '$_SERVER = ' . var_export($server, true) . '; require ' . var_export($entry, true) . '; echo http_response_code();';
            $result = $this->execute($code);
            self::assertTrue($result === "Unauthorized\n401");
        }
        $health = $this->execute('$_SERVER = ["REQUEST_METHOD" => "GET", "REQUEST_URI" => "/healthz"]; require ' . var_export($entry, true) . ';');
        self::assertSame("ok\n", $health);
    }

    private function execute(string $code): string
    {
        $process = proc_open([PHP_BINARY, '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        self::assertIsResource($process);
        $out = stream_get_contents($pipes[1]);
        $err = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        self::assertSame(0, proc_close($process));
        self::assertTrue($err === '', 'Standalone public entry must produce no logs');
        return (string) $out;
    }
}
