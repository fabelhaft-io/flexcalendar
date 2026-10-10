<?php

declare(strict_types=1);

namespace Calflex;

final class PrivateSkeletonOnly extends \Sabre\DAV\Exception\Forbidden
{
    public readonly string $name;

    public function __construct(string $name)
    {
        $this->name = preg_match('/\A[A-Z][A-Z0-9-]{0,63}\z/', $name) === 1 ? $name : 'UNLISTED';
        parent::__construct('Private skeleton only');
    }

    public function serialize(\Sabre\DAV\Server $server, \DOMElement $errorNode): void
    {
        $document = $errorNode->ownerDocument;
        $condition = $document->createElementNS('https://flexcalendar.de/ns/caldav', 'cf:private-skeleton-only');
        $condition->appendChild($document->createElementNS('https://flexcalendar.de/ns/caldav', 'cf:name', $this->name));
        $errorNode->appendChild($condition);
    }
}
