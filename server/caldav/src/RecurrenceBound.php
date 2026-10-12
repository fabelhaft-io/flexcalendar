<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\CalDAV\ICalendar;
use Sabre\DAV\INode;
use Sabre\DAV\PropFind;
use Sabre\DAV\Server;
use Sabre\DAV\ServerPlugin;
use Sabre\VObject\Settings;

/**
 * E03-R12 — the recurrence bound, set once where the service is configured.
 *
 * `sabre/vobject` bounds every series it walks; this raises the bound from its
 * default 3,500 to {@see MAX_INSTANCES}, the same cap at which the API reports
 * an object as `too-many-instances` (E05-R05). The setting is global to the
 * process, so it lives in the plugin the service installs — never in vendor
 * code — and `initialize()` is where `Service::create` turning the plugin on
 * applies it, before any request is handled.
 *
 * The same plugin answers RFC 4791 § 5.2.8's `CALDAV:max-instances` property on
 * every calendar collection, for every calendar mode: it is the property the
 * `403` `C:max-instances` precondition refers to, so a client can read the
 * bound rather than guess it. SabreDAV keeps the property protected (a client
 * cannot `PROPPATCH` it) and never serves it itself.
 */
final class RecurrenceBound extends ServerPlugin
{
    /**
     * The instances `sabre/vobject` may walk for one series. Walking this many
     * finite occurrences is what a write pays; the API's `MAX_INSTANCES` is the
     * same number, so an object one side accepts the other accepts too.
     */
    public const MAX_INSTANCES = 50_000;

    public function getPluginName(): string
    {
        return 'calflex-recurrence-bound';
    }

    public function initialize(Server $server): void
    {
        Settings::$maxRecurrences = self::MAX_INSTANCES;
        $server->on('propFind', [$this, 'propFind']);
    }

    /**
     * A calendar collection advertises the bound; nothing else does, so the
     * property stays where RFC 4791 § 5.2.8 puts it.
     */
    public function propFind(PropFind $propFind, INode $node): void
    {
        if (!$node instanceof ICalendar) {
            return;
        }
        $propFind->handle('{urn:ietf:params:xml:ns:caldav}max-instances', self::MAX_INSTANCES);
    }
}
