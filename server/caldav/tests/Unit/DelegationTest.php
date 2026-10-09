<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Delegation;
use Calflex\Tests\Signer;
use PHPUnit\Framework\TestCase;

final class DelegationTest extends TestCase
{
    public function testVectorsAndMutations(): void
    {
        $vectors = json_decode((string) file_get_contents(__DIR__ . '/../Fixtures/delegation-vectors.json'), true, 512, JSON_THROW_ON_ERROR);
        foreach ($vectors as $v) {
            $keys = [$v['keyId'] => base64_decode($v['key'], true)];
            self::assertSame($v['header'], Signer::header($v['keyId'], $keys[$v['keyId']], $v['principal'], $v['method'], $v['target'], $v['timestamp'], $v['nonce']));
            self::assertNotNull(Delegation::verify($v['header'], $v['method'], $v['target'], $keys, $v['timestamp']));
            self::assertNull(Delegation::verify($v['header'], 'DELETE', $v['target'], $keys, $v['timestamp']));
            self::assertNull(Delegation::verify($v['header'], $v['method'], $v['target'] . '/', $keys, $v['timestamp']));
            foreach ([-61, 61] as $skew) {
                self::assertNull(Delegation::verify($v['header'], $v['method'], $v['target'], $keys, $v['timestamp'] + $skew));
            }
            foreach ([-60, 60] as $skew) {
                self::assertNotNull(Delegation::verify($v['header'], $v['method'], $v['target'], $keys, $v['timestamp'] + $skew));
            }
            foreach (['', 'garbage', $v['header'] . '; v=1', $v['header'] . '; extra=x', str_replace('v=1', 'v=2', $v['header']), str_replace('k=' . $v['keyId'], 'k=unknown', $v['header']), substr($v['header'], 0, -1) . '!', str_replace('p=' . $v['principal'], 'p=invalid', $v['header'])] as $bad) {
                self::assertNull(Delegation::verify($bad, $v['method'], $v['target'], $keys, $v['timestamp']));
            }
        }
    }

    public function testKeysFailClosedAndRotation(): void
    {
        $key = base64_encode(str_repeat('a', 32));
        self::assertCount(2, Delegation::keys("old:$key,new:$key"));
        foreach (['', 'a:bad', 'a:' . base64_encode('short'), "a:$key,a:$key", "a:$key,broken"] as $bad) {
            self::assertSame([], Delegation::keys($bad));
        }
        $keys = Delegation::keys("new:$key,old:$key");
        $header = Signer::header('old', str_repeat('a', 32), '8b0e189c-43a5-4f1e-a810-5c4b5c021593', 'GET', '/');
        self::assertNotNull(Delegation::verify($header, 'GET', '/', $keys, time()));
    }
}
