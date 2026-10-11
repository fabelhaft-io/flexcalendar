<?php

declare(strict_types=1);

namespace Calflex\Tests;

/**
 * Strict reader for the multistatus bodies the discovery case asserts on.
 *
 * `str_contains` (what the E03-R01 tests use) would pass on an href that only
 * looks right, so the discovery assertions pull the exact href text out of the
 * XML instead and compare it whole. Everything unexpected (no such property,
 * the property twice, more than one href) throws rather than returning
 * something plausible.
 */
final class Multistatus
{
    public const DAV = 'DAV:';
    public const CALDAV = 'urn:ietf:params:xml:ns:caldav';

    public static function parse(string $xml): \DOMDocument
    {
        $document = new \DOMDocument();
        if (!@$document->loadXML($xml)) {
            throw new \RuntimeException('Response body is not XML');
        }

        return $document;
    }

    /**
     * The single href of the single response carrying the given property.
     */
    public static function propertyHref(string $xml, string $namespace, string $localName): string
    {
        $properties = self::parse($xml)->getElementsByTagNameNS($namespace, $localName);
        if (1 !== $properties->length) {
            throw new \RuntimeException('Expected exactly one ' . $localName . ', found ' . $properties->length);
        }
        $hrefs = $properties->item(0)?->getElementsByTagNameNS(self::DAV, 'href');
        if (null === $hrefs || 1 !== $hrefs->length) {
            throw new \RuntimeException('Expected exactly one href in ' . $localName . ', found ' . (null === $hrefs ? 0 : $hrefs->length));
        }

        return (string) $hrefs->item(0)?->textContent;
    }

    /**
     * Every response href of a Depth-1 listing, in document order.
     *
     * @return list<string>
     */
    public static function responseHrefs(string $xml): array
    {
        $hrefs = [];
        foreach (self::parse($xml)->getElementsByTagNameNS(self::DAV, 'response') as $response) {
            // The response's own href comes first; property hrefs follow it.
            $href = $response->getElementsByTagNameNS(self::DAV, 'href')->item(0);
            $hrefs[] = $href instanceof \DOMNode ? (string) $href->textContent : '';
        }

        return $hrefs;
    }
}
