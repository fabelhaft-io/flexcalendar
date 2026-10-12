<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\MaxInstances;
use Calflex\RecurrenceBound;
use Calflex\Service;
use PHPUnit\Framework\TestCase;
use Sabre\CalDAV\ICalendar;
use Sabre\DAV\ICollection;
use Sabre\DAV\PropFind;
use Sabre\DAV\Server;
use Sabre\VObject\Reader;
use Sabre\VObject\Recur\EventIterator;
use Sabre\VObject\Recur\MaxInstancesExceededException;
use Sabre\VObject\Settings;

/**
 * E03-R12 — the recurrence bound and the `403` it answers with.
 *
 * The three things this pins without the stack: the bound is 50,000 and is
 * applied where the service is configured; a series over it makes
 * `sabre/vobject` throw, and that throw becomes our `403` DAV exception (and
 * only that throw does); and a calendar collection advertises the same bound as
 * `CALDAV:max-instances` while another node does not.
 *
 * The end-to-end writes, the stored/refused series and the `calendar-query`
 * are `tests/Integration/RecurrenceBoundTest.php`: they need the listener and
 * Postgres.
 */
final class RecurrenceBoundTest extends TestCase
{
    private const PROPERTY = '{urn:ietf:params:xml:ns:caldav}max-instances';
    private const CALDAV = 'urn:ietf:params:xml:ns:caldav';

    private static function series(string $rule): string
    {
        return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Calflex//EN\r\n"
            . "BEGIN:VEVENT\r\nUID:5d6c7b8a-9012-4ef3-8abc-0123456789ab\r\n"
            . "DTSTAMP:20260101T000000Z\r\nDTSTART:20260101T000000Z\r\n"
            . "DTEND:20260101T000100Z\r\nRRULE:" . $rule . "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    }

    /**
     * `Service::create` is the common path of both front controllers, so the
     * bound is applied there and nowhere else. It builds no connection itself,
     * which is why an in-memory SQLite handle stands in for the real PDO.
     */
    public function testTheServiceRaisesTheBoundWhenItIsConfigured(): void
    {
        Settings::$maxRecurrences = 3500;
        Service::create(new \PDO('sqlite::memory:'), '8b0e189c-43a5-4f1e-a810-5c4b5c021593');
        self::assertSame(50_000, Settings::$maxRecurrences);
        self::assertSame(50_000, RecurrenceBound::MAX_INSTANCES);
    }

    /**
     * The walk the write pays: 50,000 instances pass, the 50,001st throws. This
     * is the vendor behaviour the bound controls, so it is asserted rather than
     * assumed.
     */
    public function testASeriesOverTheBoundMakesTheVendorIteratorThrow(): void
    {
        $plugin = new RecurrenceBound();
        $plugin->initialize(new Server());

        $object = Reader::read(self::series('FREQ=MINUTELY;COUNT=60000'));
        $iterator = new EventIterator($object, '5d6c7b8a-9012-4ef3-8abc-0123456789ab');
        $walked = 0;
        try {
            while ($iterator->valid()) {
                ++$walked;
                $iterator->next();
            }
            self::fail('the 60,000-instance series was walked to its end');
        } catch (MaxInstancesExceededException $exception) {
            self::assertSame(RecurrenceBound::MAX_INSTANCES, $walked);
        }
    }

    public function testTheVendorExceptionBecomesTheMaxInstancesPrecondition(): void
    {
        $translated = MaxInstances::translate(new MaxInstancesExceededException('CALFLEX_REJECTED_BODY_CANARY'));
        self::assertInstanceOf(MaxInstances::class, $translated);
        self::assertInstanceOf(\Sabre\DAV\Exception::class, $translated);
        self::assertSame(403, $translated->getHTTPCode());

        // Only that one exception is translated; everything else stays as it is,
        // so a real failure is still a real failure.
        $other = new \RuntimeException('CALFLEX_REJECTED_BODY_CANARY');
        self::assertSame($other, MaxInstances::translate($other));
    }

    public function testTheRefusalSerialisesTheCalDavPreconditionAndNothingElse(): void
    {
        $server = new Server();
        Service::errorResponse($server, new MaxInstances());
        self::assertSame(403, $server->httpResponse->getStatus());
        self::assertSame('application/xml; charset=utf-8', $server->httpResponse->getHeader('Content-Type'));
        $body = $server->httpResponse->getBodyAsString();
        $xml = new \DOMDocument();
        self::assertTrue($xml->loadXML($body));
        self::assertSame('DAV:', $xml->documentElement->namespaceURI);
        self::assertSame('error', $xml->documentElement->localName);
        $condition = $xml->getElementsByTagNameNS(self::CALDAV, 'max-instances');
        self::assertSame(1, $condition->length);
        self::assertSame('', $condition->item(0)->textContent);
        // The element really is namespace-qualified, not a bare local name.
        self::assertSame(self::CALDAV, $condition->item(0)->namespaceURI);
        // No message, class or trace reaches the body.
        self::assertStringNotContainsString('instances than this collection', $body);
        self::assertStringNotContainsString('MaxInstances', $body);
        self::assertSame(0, $xml->getElementsByTagNameNS('http://sabredav.org/ns', 'message')->length);
    }

    public function testEveryCalendarCollectionAdvertisesTheBound(): void
    {
        $plugin = new RecurrenceBound();
        $plugin->initialize(new Server());

        $calendar = $this->createStub(ICalendar::class);
        $propFind = new PropFind('calendars/user/calendar', [self::PROPERTY]);
        $plugin->propFind($propFind, $calendar);
        self::assertSame(200, $propFind->getStatus(self::PROPERTY));
        self::assertSame(RecurrenceBound::MAX_INSTANCES, $propFind->get(self::PROPERTY));

        // The property belongs to a calendar collection only: a node that is not
        // one is left answering `404`.
        $other = $this->createStub(ICollection::class);
        $absent = new PropFind('calendars/user', [self::PROPERTY]);
        $plugin->propFind($absent, $other);
        self::assertSame(404, $absent->getStatus(self::PROPERTY));
        self::assertNull($absent->get(self::PROPERTY));
    }
}
