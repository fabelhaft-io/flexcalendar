<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Tests\Multistatus;
use PHPUnit\Framework\AssertionFailedError;
use PHPUnit\Framework\TestCase;

/**
 * The discovery case in tests/Integration asserts on href text, so the reader
 * it uses has to fail on a wrong or ambiguous body rather than return
 * something plausible. The documents below are the multistatus shape SabreDAV
 * writes: response href first, then the requested properties.
 */
final class MultistatusTest extends TestCase
{
    private const ID = '11111111-1111-4111-8111-111111111111';

    public function testReadsThePropertyHref(): void
    {
        self::assertSame(
            '/principals/' . self::ID . '/',
            Multistatus::propertyHref(self::rootDocument(), Multistatus::DAV, 'current-user-principal')
        );
        self::assertSame(
            '/principals/' . self::ID . '/',
            Multistatus::propertyHref(self::principalDocument(), Multistatus::DAV, 'principal-URL')
        );
        self::assertSame(
            '/calendars/' . self::ID . '/',
            Multistatus::propertyHref(self::principalDocument(), Multistatus::CALDAV, 'calendar-home-set')
        );
    }

    public function testListsResponseHrefs(): void
    {
        self::assertSame(
            ['/calendars/' . self::ID . '/', '/calendars/' . self::ID . '/22222222-2222-4222-8222-222222222222/'],
            Multistatus::responseHrefs(self::homeDocument())
        );
    }

    public function testAmbiguousOrMissingPropertiesThrow(): void
    {
        foreach ([
            [self::homeDocument(), Multistatus::DAV, 'current-user-principal'],
            [self::principalDocument(), Multistatus::CALDAV, 'calendar-user-address-set'],
            [self::duplicatedDocument(), Multistatus::DAV, 'principal-URL'],
        ] as [$xml, $namespace, $localName]) {
            try {
                Multistatus::propertyHref($xml, $namespace, $localName);
                self::fail('Expected ' . $localName . ' to be rejected');
            } catch (\RuntimeException $exception) {
                self::assertStringContainsString($localName, $exception->getMessage());
            }
        }
    }

    public function testBodyThatIsNotMultistatusThrows(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('Response body is not XML');
        Multistatus::propertyHref('Unauthorized' . "\n", Multistatus::DAV, 'current-user-principal');
    }

    public function testAWrongExpectedHrefFails(): void
    {
        // The exact comparison the integration case makes: the reader is worth
        // nothing if a wrong value passed it. Hand-edit the expected string in
        // testReadsThePropertyHref and the same failure is what you see.
        self::expectException(AssertionFailedError::class);
        self::assertSame(
            '/principals/33333333-3333-4333-8333-333333333333/',
            Multistatus::propertyHref(self::principalDocument(), Multistatus::DAV, 'principal-URL')
        );
    }

    private static function rootDocument(): string
    {
        return '<?xml version="1.0" encoding="utf-8"?>'
            . '<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">'
            . '<d:response><d:href>/</d:href><d:propstat><d:prop>'
            . '<d:current-user-principal><d:href>/principals/' . self::ID . '/</d:href></d:current-user-principal>'
            . '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
            . '</d:multistatus>';
    }

    private static function principalDocument(): string
    {
        return '<?xml version="1.0" encoding="utf-8"?>'
            . '<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav">'
            . '<d:response><d:href>/principals/' . self::ID . '/</d:href><d:propstat><d:prop>'
            . '<d:principal-URL><d:href>/principals/' . self::ID . '/</d:href></d:principal-URL>'
            . '<cal:calendar-home-set><d:href>/calendars/' . self::ID . '/</d:href></cal:calendar-home-set>'
            . '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
            . '</d:multistatus>';
    }

    /** The same property in two propstats: exactly the shape a strict reader must refuse. */
    private static function duplicatedDocument(): string
    {
        return '<?xml version="1.0" encoding="utf-8"?>'
            . '<d:multistatus xmlns:d="DAV:">'
            . '<d:response><d:href>/principals/' . self::ID . '/</d:href>'
            . '<d:propstat><d:prop><d:principal-URL><d:href>/principals/' . self::ID . '/</d:href></d:principal-URL></d:prop>'
            . '<d:status>HTTP/1.1 200 OK</d:status></d:propstat>'
            . '<d:propstat><d:prop><d:principal-URL><d:href>/principals/' . self::ID . '/</d:href></d:principal-URL></d:prop>'
            . '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
            . '</d:multistatus>';
    }

    private static function homeDocument(): string
    {
        return '<?xml version="1.0" encoding="utf-8"?>'
            . '<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">'
            . '<d:response><d:href>/calendars/' . self::ID . '/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>'
            . '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
            . '<d:response><d:href>/calendars/' . self::ID . '/22222222-2222-4222-8222-222222222222/</d:href><d:propstat><d:prop>'
            . '<d:resourcetype><d:collection/><cal:calendar xmlns:cal="urn:ietf:params:xml:ns:caldav"/></d:resourcetype>'
            . '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
            . '</d:multistatus>';
    }
}
