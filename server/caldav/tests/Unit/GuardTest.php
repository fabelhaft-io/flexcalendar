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

    /**
     * E03-R11 — the value backstop's own tables, beside the E03-R09 ones. A
     * lowercase UUIDv4 on `<uid>.ics` is accepted, an alarm without a `UID` and
     * the `PRODID`/`TZID`/`TZNAME`/`TZURL`/`X-LIC-LOCATION` values the API
     * writes are not touched, and an update keeps a store `UID` of any shape.
     */
    public function testObjectAllowedTables(): void
    {
        $creates = GuardCases::objectCreatesAllowed();
        $updates = GuardCases::objectUpdatesAllowed();
        self::assertNotEmpty($creates);
        self::assertNotEmpty($updates);
        foreach ($creates as $case => $row) {
            try {
                PrivateSkeleton::createObject($row['uri'], $row['text']);
            } catch (SkeletonViolation $exception) {
                self::fail($case . ' must be accepted, refused for ' . $exception->name);
            }
        }
        foreach ($updates as $case => $row) {
            try {
                PrivateSkeleton::updateObject($row['stored'], $row['text']);
            } catch (SkeletonViolation $exception) {
                self::fail($case . ' must be accepted, refused for ' . $exception->name);
            }
        }
    }

    public function testObjectRejectedTables(): void
    {
        foreach (GuardCases::objectCreatesRejected() as $case => $row) {
            $this->refuses(
                $case,
                $row['name'],
                static fn () => PrivateSkeleton::createObject($row['uri'], $row['text']),
            );
        }
        foreach (GuardCases::objectUpdatesRejected() as $case => $row) {
            $this->refuses(
                $case,
                $row['name'],
                static fn () => PrivateSkeleton::updateObject($row['stored'], $row['text']),
            );
        }
    }

    /**
     * The refusal a Private write gets: the E03-R09 precondition, the offending
     * name only, and never a marker the refused value carried.
     *
     * @param \Closure(): void $write
     */
    private function refuses(string $case, string $name, \Closure $write): void
    {
        try {
            $write();
            self::fail('Rejected row passed: ' . $case);
        } catch (SkeletonViolation $exception) {
            self::assertSame($name, $exception->name, $case);
            self::assertSame('Private skeleton only', $exception->getMessage(), $case);
            $server = new \Sabre\DAV\Server();
            Service::errorResponse($server, new PrivateSkeletonOnly($exception->name));
            self::assertSame(403, $server->httpResponse->getStatus(), $case);
            $body = $server->httpResponse->getBodyAsString();
            self::assertStringNotContainsString('CALFLEX_GUARD_MARKER', $body, $case);
            $xml = new \DOMDocument();
            self::assertTrue($xml->loadXML($body), $case);
            self::assertSame(1, $xml->getElementsByTagNameNS('https://flexcalendar.de/ns/caldav', 'private-skeleton-only')->length, $case);
            self::assertSame($name, $xml->getElementsByTagNameNS('https://flexcalendar.de/ns/caldav', 'name')->item(0)?->textContent, $case);
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

    /**
     * E03-R11 — the value checks answer the same `403` and run on a Private
     * calendar only: a Shared collection takes a `UID` that names an event, a
     * name that is not `<uid>.ics` and an `X-` rule part, because the E03-R09
     * allow-list is what still applies there (INV-01 keeps that content
     * server-side and the guard does not add a rule of its own).
     */
    public function testModeAwareWrites(): void
    {
        $id = GuardCases::UID;
        foreach (['private', null, 'shared'] as $mode) {
            $guard = new WriteGuard(static fn (string $lookupId): ?string => $mode);
            // Accepted writes exercise every entry point on the happy path too:
            // a create under `<uid>.ics`, an update that keeps the stored `UID`
            // of any shape, and the collection's one writable property.
            $guard->createObject($id, GuardCases::uri(), GuardCases::skeleton());
            $guard->updateObject($id, GuardCases::skeleton(), GuardCases::UID);
            $guard->updateObject($id, GuardCases::skeleton('1A2B3C4D-5E6F-4A0B-8C1D-2E3F4A5B6C7D'), '1A2B3C4D-5E6F-4A0B-8C1D-2E3F4A5B6C7D');
            $guard->properties($id, ['{DAV:}displayname' => 'Private calendar']);
            $writes = [
                'SUMMARY' => static fn () => $guard->createObject($id, GuardCases::uri(), GuardCases::eventLine('SUMMARY:CALFLEX_GUARD_MARKER_write')),
                'UID' => static fn () => $guard->createObject($id, GuardCases::uri(), GuardCases::skeleton('CALFLEX_GUARD_MARKER_uid')),
                'OBJECT-NAME' => static fn () => $guard->createObject($id, 'CALFLEX_GUARD_MARKER_object_name.ics', GuardCases::skeleton()),
                'RRULE' => static fn () => $guard->createObject($id, GuardCases::uri(), GuardCases::eventLine('RRULE:FREQ=DAILY;X-NOTE=CALFLEX_GUARD_MARKER_rrule')),
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
            self::assertSame($mode === 'shared' ? 5 : 0, $accepted);
        }
    }

    /**
     * E03-R11 — an update keeps the `UID` the store holds whatever its shape, so
     * a Shared calendar switched to Private keeps its stock-app `UID`s (INV-03),
     * and a rewrite that changes it, or drops it, is refused.
     */
    public function testUpdateKeepsTheStoredUid(): void
    {
        $id = GuardCases::UID;
        foreach ([null, 'private', 'unexpected'] as $mode) {
            $guard = new WriteGuard(static fn (string $lookupId): ?string => $mode);
            foreach (['1A2B3C4D-5E6F-4A0B-8C1D-2E3F4A5B6C7D', '{9f2c4d31-6e08-7a55-b3c2-0d1e2f3a4b5c}', 'legacy-object-1'] as $stored) {
                $guard->updateObject($id, GuardCases::skeleton($stored), $stored);
            }
            try {
                $guard->updateObject($id, GuardCases::skeleton(), '1A2B3C4D-5E6F-4A0B-8C1D-2E3F4A5B6C7D');
                self::fail('An update that changes the stored UID passed the guard');
            } catch (PrivateSkeletonOnly $exception) {
                self::assertSame('UID', $exception->name);
            }
            try {
                $guard->updateObject($id, GuardCases::skeleton(), null);
                self::fail('An update without a stored UID passed the guard');
            } catch (PrivateSkeletonOnly $exception) {
                self::assertSame('UID', $exception->name);
            }
        }
        // A Shared collection is not checked at all, stored UID or name.
        $shared = new WriteGuard(static fn (string $lookupId): string => 'shared');
        $shared->updateObject($id, GuardCases::eventLine('SUMMARY:CALFLEX_GUARD_MARKER_shared'), null);
        $shared->createObject($id, 'not-a-uid.ics', GuardCases::skeleton('CALFLEX_GUARD_MARKER_shared'));
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
                $guard->createObject($id, GuardCases::uri(), 'not iCalendar');
                $guard->properties($id, ['{DAV:}displayname' => 'Unencrypted name']);
            }
        }
        self::assertSame(9, $calls);
        $guard = new WriteGuard(static fn () => throw new \RuntimeException('DB unavailable'));
        $this->expectException(\RuntimeException::class);
        $guard->createObject($id, GuardCases::uri(), GuardCases::skeleton());
    }
}
