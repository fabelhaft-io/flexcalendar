<?php

declare(strict_types=1);

namespace Calflex;

final class Service
{
    public static function run(\Sabre\DAV\Server $server): void
    {
        try {
            $server->httpRequest->setBaseUrl('/');
            $server->invokeMethod($server->httpRequest, $server->httpResponse);
        } catch (\Throwable $exception) {
            self::errorResponse($server, $exception);
            error_log('caldav dav_failure');
            $server->sapi->sendResponse($server->httpResponse);
        }
    }

    public static function errorResponse(\Sabre\DAV\Server $server, \Throwable $exception): void
    {
        $davException = $exception instanceof \Sabre\DAV\Exception;
        $server->httpResponse->setStatus($davException ? $exception->getHTTPCode() : 500);
        $server->httpResponse->setHeader('Content-Type', 'application/xml; charset=utf-8');
        $document = new \DOMDocument('1.0', 'utf-8');
        $error = $document->createElementNS('DAV:', 'd:error');
        $error->setAttribute('xmlns:s', 'http://sabredav.org/ns');
        $document->appendChild($error);
        if ($davException) {
            $exception->serialize($server, $error);
            $server->httpResponse->setHeaders($exception->getHTTPHeaders($server));
        }
        // Include preconditions only: never exception message, class or trace.
        $server->httpResponse->setBody($document->saveXML());
    }

    public static function create(\PDO $pdo, string $id): \Sabre\DAV\Server
    {
        \Sabre\DAV\Server::$exposeVersion = false;
        $principals = new Principals($pdo, 'principals/' . $id);
        $guard = WriteGuard::fromPdo($pdo);
        $calendars = new GuardedCalendars($pdo, $guard, $id);
        $calendars->calendarTableName = 'sabredav.calendars';
        $calendars->calendarInstancesTableName = 'sabredav.calendarinstances';
        $calendars->calendarObjectTableName = 'sabredav.calendarobjects';
        $calendars->calendarChangesTableName = 'sabredav.calendarchanges';
        $calendars->schedulingObjectTableName = 'sabredav.schedulingobjects';
        $calendars->calendarSubscriptionsTableName = 'sabredav.calendarsubscriptions';
        $server = new \Sabre\DAV\Server([new \Sabre\DAVACL\PrincipalCollection($principals), new MembershipCalendarRoot($principals, $calendars)]);
        $server->setBaseUri('/');
        $server->addPlugin(new \Sabre\DAV\Auth\Plugin(new Authenticated('principals/' . $id)));
        $server->addPlugin(new \Sabre\CalDAV\Plugin());
        $acl = new MembershipPlugin();
        $acl->allowUnauthenticatedAccess = false;
        $acl->hideNodesFromListings = true;
        $server->addPlugin($acl);
        $server->addPlugin(new \Sabre\DAV\Sync\Plugin());
        $properties = new GuardedProperties($pdo, $guard);
        $properties->tableName = 'sabredav.propertystorage';
        $server->addPlugin(new \Sabre\DAV\PropertyStorage\Plugin($properties));
        return $server;
    }
}
