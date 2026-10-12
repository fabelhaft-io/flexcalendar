<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\DAV\Server;
use Sabre\VObject\Recur\MaxInstancesExceededException;

/**
 * E03-R12 — RFC 4791 § 5.3.2.1's `CALDAV:max-instances` precondition.
 *
 * `sabre/vobject` throws its plain `MaxInstancesExceededException` once a series
 * passes `Settings::$maxRecurrences`, and SabreDAV walks every *finite* series
 * on every object write to store its last occurrence, so the default bound
 * (3,500) refused a daily `COUNT=4000` with a `500`. The service raises this
 * instead: a DAV exception answering `403` whose body serialises the one
 * precondition element the RFC names, in the CalDAV namespace — the shape
 * `PrivateSkeletonOnly` gives its `cf:` precondition, and nothing else (no
 * message, class or trace ever reaches the body).
 *
 * The element is `<C:max-instances/>` in `urn:ietf:params:xml:ns:caldav`. The
 * property it refers to is served on every calendar collection by
 * {@see RecurrenceBound}, so a client can read the bound the `403` names.
 */
final class MaxInstances extends \Sabre\DAV\Exception\Forbidden
{
    public function __construct()
    {
        parent::__construct('The series has more instances than this collection accepts');
    }

    /**
     * The DAV shape of the bound, so a caller can rethrow what a walk threw.
     * Anything that is not the vendor's exception passes through unchanged, so
     * a real failure stays a real failure.
     */
    public static function translate(\Throwable $exception): \Throwable
    {
        return $exception instanceof MaxInstancesExceededException
            ? new self()
            : $exception;
    }

    public function serialize(Server $server, \DOMElement $errorNode): void
    {
        $document = $errorNode->ownerDocument;
        $condition = $document->createElementNS('urn:ietf:params:xml:ns:caldav', 'C:max-instances');
        $errorNode->appendChild($condition);
    }
}
