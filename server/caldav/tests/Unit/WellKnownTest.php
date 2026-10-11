<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * The discovery match itself. It lives in the standalone public entry, so the
 * entry is loaded once here (its own request produces no output) and the
 * function is then called directly, one case per path.
 */
final class WellKnownTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        if (function_exists('calflex_discovery_target')) {
            return;
        }
        $previous = $_SERVER['REQUEST_URI'] ?? null;
        $_SERVER['REQUEST_URI'] = '/.well-known/caldav';
        ob_start();
        require_once dirname(__DIR__, 2) . '/public/index.php';
        ob_end_clean();
        if (null === $previous) {
            unset($_SERVER['REQUEST_URI']);
        } else {
            $_SERVER['REQUEST_URI'] = $previous;
        }
    }

    public function testExactWellKnownPathRedirects(): void
    {
        foreach ([
            '/.well-known/caldav',
            '/.well-known/caldav?',
            '/.well-known/caldav?x=1',
            '/.well-known/caldav?next=https://evil.invalid/',
            '/.well-known/caldav?x=%2F..%2Fcalendars%2F',
        ] as $uri) {
            self::assertSame('/', \calflex_discovery_target($uri), $uri);
        }
    }

    public function testNothingElseRedirects(): void
    {
        foreach ([
            '/.well-known/caldav/',
            '/.well-known/CALDAV',
            '/.well-known/CalDav',
            '/.well-known/caldavx',
            '/.well-known/carddav',
            '//.well-known/caldav',
            '/x/.well-known/caldav',
            '/.well-known/caldav%2F',
            '/.well-known/caldav%3Fx=1',
            'https://caldav.invalid/.well-known/caldav',
            '/.well-known',
            '/.well-known/',
            '/healthz',
            '/',
            '',
        ] as $uri) {
            self::assertNull(\calflex_discovery_target($uri), $uri);
        }
    }

    public function testTargetIsTheServiceRootOnly(): void
    {
        // No query, path segment or absolute URL from the request survives into
        // the answer, so the redirect cannot be pointed anywhere else.
        self::assertSame('/', \calflex_discovery_target('/.well-known/caldav?next=//evil.invalid'));
        self::assertSame('/', \calflex_discovery_target('/.well-known/caldav?Location=https://evil.invalid'));
    }
}
