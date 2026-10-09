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
            $status = $exception instanceof \Sabre\DAV\Exception ? $exception->getHTTPCode() : 500;
            $server->httpResponse->setStatus($status);
            $server->httpResponse->setHeader('Content-Type', 'text/plain; charset=utf-8');
            $server->httpResponse->setBody("DAV request failed\n");
            error_log('caldav dav_failure');
            $server->sapi->sendResponse($server->httpResponse);
        }
    }

    public static function create(\PDO $pdo, string $id): \Sabre\DAV\Server
    {
        $principals = new Principals($pdo, 'principals/' . $id);
        $calendars = new \Sabre\CalDAV\Backend\PDO($pdo);
        $calendars->calendarTableName = 'sabredav.calendars';
        $calendars->calendarInstancesTableName = 'sabredav.calendarinstances';
        $calendars->calendarObjectTableName = 'sabredav.calendarobjects';
        $calendars->calendarChangesTableName = 'sabredav.calendarchanges';
        $calendars->schedulingObjectTableName = 'sabredav.schedulingobjects';
        $calendars->calendarSubscriptionsTableName = 'sabredav.calendarsubscriptions';
        $server = new \Sabre\DAV\Server([new \Sabre\DAVACL\PrincipalCollection($principals), new \Sabre\CalDAV\CalendarRoot($principals, $calendars)]);
        $server->setBaseUri('/');
        $server->addPlugin(new \Sabre\DAV\Auth\Plugin(new Authenticated('principals/' . $id)));
        $server->addPlugin(new \Sabre\CalDAV\Plugin());
        $acl = new \Sabre\DAVACL\Plugin();
        $acl->allowUnauthenticatedAccess = false;
        $acl->hideNodesFromListings = true;
        $server->addPlugin($acl);
        $server->addPlugin(new \Sabre\DAV\Sync\Plugin());
        $properties = new \Sabre\DAV\PropertyStorage\Backend\PDO($pdo);
        $properties->tableName = 'sabredav.propertystorage';
        $server->addPlugin(new \Sabre\DAV\PropertyStorage\Plugin($properties));
        return $server;
    }
}
