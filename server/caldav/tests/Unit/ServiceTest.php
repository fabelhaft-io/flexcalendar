<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Service;
use PHPUnit\Framework\TestCase;
use Sabre\DAV\Exception\MethodNotAllowed;
use Sabre\DAV\Exception\PreconditionFailed;
use Sabre\DAV\Server;

final class ServiceTest extends TestCase
{
    public function testPreconditionSerializationWithoutExceptionDetails(): void
    {
        $server = new Server();
        Service::errorResponse($server, new PreconditionFailed('REJECTED_MESSAGE_CANARY', 'If-None-Match'));
        self::assertSame(412, $server->httpResponse->getStatus());
        self::assertSame('application/xml; charset=utf-8', $server->httpResponse->getHeader('Content-Type'));
        $body = $server->httpResponse->getBodyAsString();
        $xml = new \DOMDocument();
        self::assertTrue($xml->loadXML($body));
        self::assertSame('DAV:', $xml->documentElement->namespaceURI);
        self::assertSame('error', $xml->documentElement->localName);
        self::assertSame('If-None-Match', $xml->getElementsByTagNameNS('http://sabredav.org/ns', 'header')->item(0)?->textContent);
        self::assertStringNotContainsString('REJECTED_MESSAGE_CANARY', $body);
        self::assertStringNotContainsString('PreconditionFailed', $body);
        foreach (['message', 'exception', 'stacktrace'] as $element) {
            self::assertSame(0, $xml->getElementsByTagNameNS('http://sabredav.org/ns', $element)->length);
        }
    }

    public function testExceptionHeadersAndGenericFailure(): void
    {
        $server = new Server();
        $server->setBaseUri('/');
        $server->httpRequest = new \Sabre\HTTP\Request('MKCOL', '/');
        Service::errorResponse($server, new MethodNotAllowed('REJECTED_MESSAGE_CANARY'));
        self::assertSame(405, $server->httpResponse->getStatus());
        self::assertStringContainsString('PROPFIND', (string) $server->httpResponse->getHeader('Allow'));
        self::assertStringNotContainsString('REJECTED_MESSAGE_CANARY', $server->httpResponse->getBodyAsString());
        Service::errorResponse($server, new \RuntimeException('REJECTED_MESSAGE_CANARY'));
        self::assertSame(500, $server->httpResponse->getStatus());
        self::assertStringNotContainsString('REJECTED_MESSAGE_CANARY', $server->httpResponse->getBodyAsString());
    }
}
