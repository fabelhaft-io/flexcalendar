<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Structure;
use PHPUnit\Framework\TestCase;

final class StructureTest extends TestCase
{
    public function testRecordAndTampering(): void
    {
        $root = dirname(__DIR__, 2);
        $lock = json_decode((string) file_get_contents($root . '/composer.lock'), true, 512, JSON_THROW_ON_ERROR);
        $record = json_decode((string) file_get_contents($root . '/../api/sabredav/record.json'), true, 512, JSON_THROW_ON_ERROR);
        self::assertTrue(Structure::matchesRecord($lock, $record));
        foreach (['tag', 'commit'] as $field) {
            $tampered = $record;
            $tampered[$field] = 'tampered';
            self::assertFalse(Structure::matchesRecord($lock, $tampered));
        }
    }

    public function testClassicOnlyAndPublicIndependence(): void
    {
        $root = dirname(__DIR__, 2);
        $config = (string) file_get_contents($root . '/Caddyfile');
        self::assertTrue(Structure::classic($config));
        self::assertFalse(Structure::classic($config . "\nworker /app/index.php"));
        $public = (string) file_get_contents($root . '/public/index.php');
        foreach (['HTTP_X_CALFLEX_PRINCIPAL', 'X-Calflex-Principal', 'require', 'include', 'Delegation', 'PDO'] as $forbidden) {
            self::assertStringNotContainsString($forbidden, $public);
        }
    }
}
