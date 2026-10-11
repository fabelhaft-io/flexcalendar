<?php

declare(strict_types=1);

namespace Calflex\Tests\Unit;

use Calflex\Service;
use PHPUnit\Framework\TestCase;
use Sabre\DAV\Exception\MethodNotAllowed;
use Sabre\DAV\Exception\PreconditionFailed;
use Sabre\DAV\Server;
use Sabre\Xml\ParseException;

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

    /**
     * E05-R10: an XML body Sabre cannot parse is the caller's mistake. Sabre
     * throws `Sabre\Xml\ParseException` straight out of
     * `CorePlugin::httpReport`; it is not a DAV exception, so before the fix it
     * became a 500 for a malformed or empty `REPORT` body.
     */
    public function testXmlParseFailuresAreBadRequestsOnly(): void
    {
        foreach (['', '<broken'] as $body) {
            $server = new Server();
            $server->setBaseUri('/');
            $server->httpRequest = new \Sabre\HTTP\Request('REPORT', '/principals/x/');
            if ($body !== '') {
                $server->httpRequest->setBody($body);
            }
            try {
                // The real REPORT pipeline: the parse failure is thrown, not
                // wrapped, so this is the exception `Service::run` catches.
                $server->invokeMethod($server->httpRequest, $server->httpResponse, false);
                self::fail('the malformed REPORT was accepted: ' . var_export($body, true));
            } catch (\Throwable $exception) {
                self::assertInstanceOf(ParseException::class, $exception);
                Service::errorResponse($server, $exception);
            }
            self::assertSame(400, $server->httpResponse->getStatus(), 'body ' . var_export($body, true));
            $response = $server->httpResponse->getBodyAsString();
            self::assertStringContainsString('error', $response);
            self::assertStringNotContainsString('ParseException', $response);
            self::assertStringNotContainsString('broken', $response);
        }
    }

    /**
     * The same bodies through the real service, `Service::run` included. The CLI
     * SAPI writes the body to stdout and cannot set headers once PHPUnit has
     * printed, so both are captured and dropped here.
     */
    public function testMalformedAndEmptyReportBodiesThroughTheService(): void
    {
        foreach (['', '<broken'] as $body) {
            $server = new Server();
            $server->setBaseUri('/');
            $server->httpRequest = new \Sabre\HTTP\Request('REPORT', '/principals/x/');
            if ($body !== '') {
                $server->httpRequest->setBody($body);
            }
            set_error_handler(static fn (): bool => true);
            ob_start();
            try {
                Service::run($server);
            } finally {
                ob_end_clean();
                restore_error_handler();
            }
            self::assertSame(400, $server->httpResponse->getStatus(), 'body ' . var_export($body, true));
            self::assertStringNotContainsString('ParseException', $server->httpResponse->getBodyAsString());
        }
    }
}
