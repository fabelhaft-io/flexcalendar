<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\PrivateSkeleton;
use Calflex\PrivateSkeletonOnly;
use Calflex\Service;
use Calflex\SkeletonViolation;
use Calflex\Tests\GuardCases;
use Calflex\WriteGuard;
use PHPUnit\Framework\TestCase;

final class GuardTest extends TestCase
{
    public function testAllowedTable(): void
    {
        foreach (GuardCases::allowed() as $text) {
            PrivateSkeleton::calendar($text);
        }
        PrivateSkeleton::calendar(\Calflex\Tests\EventFixture::create('adf46a78-3c92-4c1e-ab04-7f791296e61e'));
        PrivateSkeleton::properties([]);
        PrivateSkeleton::properties(['{DAV:}displayname' => 'Private calendar']);
        self::assertNotEmpty(GuardCases::allowed());
    }

    public function testRejectedTable(): void
    {
        foreach (GuardCases::rejected() as [$text, $name]) {
            try {
                PrivateSkeleton::calendar($text);
                self::fail('Rejected row passed: ' . $name);
            } catch (SkeletonViolation $exception) {
                self::assertSame($name, $exception->name);
                self::assertSame('Private skeleton only', $exception->getMessage());
                $server = new \Sabre\DAV\Server();
                Service::errorResponse($server, new PrivateSkeletonOnly($exception->name));
                self::assertSame(403, $server->httpResponse->getStatus());
                $body = $server->httpResponse->getBodyAsString();
                self::assertStringNotContainsString('CALFLEX_GUARD_MARKER', $body);
                $xml = new \DOMDocument();
                self::assertTrue($xml->loadXML($body));
                self::assertSame(1, $xml->getElementsByTagNameNS('https://flexcalendar.de/ns/caldav', 'private-skeleton-only')->length);
                self::assertSame($name, $xml->getElementsByTagNameNS('https://flexcalendar.de/ns/caldav', 'name')->item(0)?->textContent);
            }
        }
    }

    public function testCollectionPropertiesAndSafeNames(): void
    {
        foreach (['{http://apple.com/ns/ical/}calendar-color', '{urn:ietf:params:xml:ns:caldav}calendar-description', '{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set', '{urn:ietf:params:xml:ns:caldav}calendar-timezone', '{DAV:}displayname', '{DAV:}unknown'] as $name) {
            try {
                PrivateSkeleton::properties([$name => 'CALFLEX_GUARD_MARKER_property']);
                self::fail('Property passed');
            } catch (SkeletonViolation $exception) {
                self::assertSame(strtoupper(substr($name, (int) strrpos($name, '}') + 1)), $exception->name);
                self::assertSame('Private skeleton only', $exception->getMessage());
            }
        }
        foreach (['bad name', str_repeat('A', 65), '123', 'NAME<', ''] as $name) {
            self::assertSame('UNLISTED', (new SkeletonViolation($name))->name);
        }
        $this->expectException(SkeletonViolation::class);
        PrivateSkeleton::properties(['{DAV:}displayname' => 'Private calendar'], false);
    }

    public function testModesAndNoCache(): void
    {
        $mode = null;
        $calls = 0;
        $guard = new WriteGuard(static function (string $id) use (&$mode, &$calls): ?string {
            ++$calls;
            return $mode;
        });
        $id = 'adf46a78-3c92-4c1e-ab04-7f791296e61e';
        self::assertTrue($guard->private('not-a-uuid'));
        self::assertSame(0, $calls);
        foreach ([null, 'private', 'shared', 'published', 'unexpected'] as $mode) {
            self::assertSame(!in_array($mode, ['shared', 'published'], true), $guard->private($id));
            if (in_array($mode, ['shared', 'published'], true)) {
                $guard->calendar($id, 'not iCalendar');
                $guard->properties($id, ['{DAV:}displayname' => 'Unencrypted name']);
            }
        }
        self::assertSame(9, $calls);
        $guard = new WriteGuard(static fn () => throw new \RuntimeException('DB unavailable'));
        $this->expectException(\RuntimeException::class);
        $guard->calendar($id, GuardCases::skeleton());
    }
}
