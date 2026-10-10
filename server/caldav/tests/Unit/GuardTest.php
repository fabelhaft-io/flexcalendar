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
        foreach (['{http://apple.com/ns/ical/}calendar-color', '{urn:ietf:params:xml:ns:caldav}calendar-description', '{DAV:}unknown'] as $name) {
            try {
                PrivateSkeleton::properties([$name => 'Private calendar']);
                self::fail('Unlisted property with allowed value passed');
            } catch (SkeletonViolation $exception) {
                self::assertSame(strtoupper(substr($name, (int) strrpos($name, '}') + 1)), $exception->name);
            }
        }
        foreach (['bad name', str_repeat('A', 65), '123', 'NAME<', ''] as $name) {
            self::assertSame('UNLISTED', (new SkeletonViolation($name))->name);
        }
        $this->expectException(SkeletonViolation::class);
        PrivateSkeleton::properties(['{DAV:}displayname' => 'Private calendar'], false);
    }

    public function testNonCalendarParsedRoots(): void
    {
        // MimeDir only accepts VCALENDAR/VCARD on the wire. Change its document
        // default name to exercise our independent root check after parsing.
        $original = \Sabre\VObject\Component\VCalendar::$defaultName;
        try {
            foreach (['VEVENT', 'VTODO'] as $name) {
                \Sabre\VObject\Component\VCalendar::$defaultName = $name;
                $text = "BEGIN:VCALENDAR\r\nEND:" . $name . "\r\n";
                try {
                    PrivateSkeleton::calendar($text);
                    self::fail('Non-calendar root passed');
                } catch (SkeletonViolation $exception) {
                    self::assertSame('VCALENDAR', $exception->name);
                }
            }
        } finally {
            \Sabre\VObject\Component\VCalendar::$defaultName = $original;
        }
    }

    public function testResponseExceptionSafeNames(): void
    {
        foreach (['bad name', str_repeat('A', 65)] as $name) {
            $exception = new PrivateSkeletonOnly($name);
            self::assertSame('UNLISTED', $exception->name);
            $server = new \Sabre\DAV\Server();
            Service::errorResponse($server, $exception);
            self::assertSame(403, $server->httpResponse->getStatus());
            $xml = new \DOMDocument();
            self::assertTrue($xml->loadXML($server->httpResponse->getBodyAsString()));
            self::assertSame(1, $xml->getElementsByTagNameNS('https://flexcalendar.de/ns/caldav', 'private-skeleton-only')->length);
            self::assertSame('UNLISTED', $xml->getElementsByTagNameNS('https://flexcalendar.de/ns/caldav', 'name')->item(0)?->textContent);
        }
    }

    public function testModeAwareWrites(): void
    {
        $id = 'adf46a78-3c92-4c1e-ab04-7f791296e61e';
        foreach (['private', null, 'shared'] as $mode) {
            $guard = new WriteGuard(static fn (string $lookupId): ?string => $mode);
            // Accepted writes exercise both entry points on the happy path too.
            $guard->calendar($id, GuardCases::skeleton());
            $guard->properties($id, ['{DAV:}displayname' => 'Private calendar']);
            $writes = [
                'SUMMARY' => static fn () => $guard->calendar($id, GuardCases::eventLine('SUMMARY:CALFLEX_GUARD_MARKER_write')),
                'CALENDAR-COLOR' => static fn () => $guard->properties($id, ['{http://apple.com/ns/ical/}calendar-color' => 'Private calendar']),
            ];
            $accepted = 0;
            foreach ($writes as $name => $write) {
                if ($mode === 'shared') {
                    $write();
                    ++$accepted;
                    continue;
                }
                try {
                    $write();
                    self::fail('Private or missing-row write passed: ' . $name);
                } catch (PrivateSkeletonOnly $exception) {
                    self::assertSame($name, $exception->name);
                    self::assertSame('Private skeleton only', $exception->getMessage());
                }
            }
            self::assertSame($mode === 'shared' ? 2 : 0, $accepted);
        }
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
