<?php

declare(strict_types=1);

namespace Calflex;

/**
 * A CalDAV collection without a public.calendars row cannot be written to: the
 * caldav_changes foreign key would reject the outbox row, so the write is
 * refused up front with a 403 instead of failing after the object write.
 */
final class UnmappedCollection extends \Sabre\DAV\Exception\Forbidden
{
    public function __construct()
    {
        parent::__construct('CalDAV collection is not registered');
    }

    public function serialize(\Sabre\DAV\Server $server, \DOMElement $errorNode): void
    {
        $document = $errorNode->ownerDocument;
        $errorNode->appendChild($document->createElementNS('https://flexcalendar.de/ns/caldav', 'cf:unmapped-collection'));
    }
}
