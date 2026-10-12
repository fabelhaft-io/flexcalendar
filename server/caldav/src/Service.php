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
            // Only a server-side failure is logged. A rejected precondition, a
            // 404 or a 412 is expected protocol traffic and the access line
            // (`internal/index.php`) already carries its status: logging every
            // one of them was 66 lines of noise in a single test run (E05-R10).
            if ($server->httpResponse->getStatus() >= 500) {
                error_log('caldav dav_failure');
            }
            $server->sapi->sendResponse($server->httpResponse);
        }
    }

    public static function errorResponse(\Sabre\DAV\Server $server, \Throwable $exception): void
    {
        $davException = $exception instanceof \Sabre\DAV\Exception;
        // A body the XML reader cannot parse is the caller's mistake, not ours:
        // Sabre throws `Sabre\Xml\ParseException` (`LibXMLException` extends it)
        // out of `CorePlugin::httpReport`, and it is not a DAV exception, so it
        // must answer 400 instead of falling through to 500. Nothing else is
        // widened to a 400.
        $status = $davException
            ? $exception->getHTTPCode()
            : ($exception instanceof \Sabre\Xml\ParseException ? 400 : 500);
        $server->httpResponse->setStatus($status);
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
        // E03-R12: raise `sabre/vobject`'s recurrence bound to 50,000 and serve
        // it as the collection's `CALDAV:max-instances`. Adding the plugin is
        // what applies the setting, so it is applied once, here, and never in
        // vendor code.
        $server->addPlugin(new RecurrenceBound());
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
