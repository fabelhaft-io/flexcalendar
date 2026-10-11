<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Service;
use Calflex\UnmappedCollection;
use PHPUnit\Framework\TestCase;

final class UnmappedCollectionTest extends TestCase
{
    public function testRefusalCarriesOnlyThePrecondition(): void
    {
        $server = new \Sabre\DAV\Server();
        Service::errorResponse($server, new UnmappedCollection());
        self::assertSame(403, $server->httpResponse->getStatus());
        $xml = new \DOMDocument();
        self::assertTrue($xml->loadXML($server->httpResponse->getBodyAsString()));
        self::assertSame('DAV:', $xml->documentElement->namespaceURI);
        self::assertSame('error', $xml->documentElement->localName);
        self::assertSame(1, $xml->getElementsByTagNameNS('https://flexcalendar.de/ns/caldav', 'unmapped-collection')->length);
        self::assertSame(0, $xml->getElementsByTagNameNS('http://sabredav.org/ns', 'message')->length);
        self::assertSame(0, $xml->getElementsByTagNameNS('http://sabredav.org/ns', 'exception')->length);
    }
}
