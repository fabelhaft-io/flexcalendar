<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\DAV;
use Sabre\DAV\Exception\Forbidden;
use Sabre\DAV\Exception\NotFound;
use Sabre\HTTP\RequestInterface;
use Sabre\HTTP\ResponseInterface;

/**
 * E03-R08 — permissions never change through CalDAV.
 *
 * The API owns `calendar_members`, so `ACL` is refused for everyone, the owner
 * included, and a `POST` that reaches a calendar collection (the CalDAV sharing
 * extension's `share-resource` verb) is refused until E03-R05 reconciles shares
 * in Phase 4.
 *
 * It also tightens the one privilege the DAVACL plugin cannot express: deleting
 * a collection is an `{DAV:}unbind` check on the *parent*, and the parent home
 * belongs to the acting user, so on its own it would let a viewer delete a
 * calendar they can only read. The node itself is checked as well.
 */
final class MembershipPlugin extends \Sabre\DAVACL\Plugin
{
    public function initialize(DAV\Server $server): void
    {
        parent::initialize($server);
        // Before the DAVACL plugin's own beforeMethod listeners, and before the
        // server gives up with a 501 for the unhandled method.
        $server->on('method:POST', [$this, 'httpPost'], 10);
    }

    /**
     * The `ACL` method is refused for every principal, the owner included.
     */
    public function httpAcl(RequestInterface $request, ResponseInterface $response): bool
    {
        throw new Forbidden('Calendar permissions are managed by the API');
    }

    /**
     * A calendar collection accepts no POST at all: the only POST CalDAV defines
     * on one is the sharing extension's `share-resource`, and shares are the
     * API's. A POST to any other node is left to the server (501).
     */
    public function httpPost(RequestInterface $request): bool
    {
        try {
            $node = $this->server->tree->getNodeForPath($request->getPath());
        } catch (NotFound) {
            return true;
        }
        if ($node instanceof \Sabre\CalDAV\ICalendar || $node instanceof \Sabre\CalDAV\ICalendarObject) {
            throw new Forbidden('Calendar collections do not accept POST');
        }

        return true;
    }

    /**
     * Deleting a calendar is checked against the collection node as well, so a
     * viewer is refused here. The DAVACL plugin's own handler only checks
     * `{DAV:}unbind` on the parent home, and that home belongs to the acting
     * user, so on its own it would let a viewer delete a collection they may
     * only read; an editor holds `{DAV:}unbind` on the collection (it is how it
     * deletes objects), passes this check and is then stopped by the backend's
     * `deleteCalendar`, which requires the owner. For an object the parent
     * calendar's `{DAV:}unbind` is the right check, which is what the DAVACL
     * plugin's own handler does.
     *
     * @param string $uri
     *
     * @return void
     */
    public function beforeUnbind($uri)
    {
        try {
            $node = $this->server->tree->getNodeForPath($uri);
        } catch (NotFound) {
            $node = null;
        }
        if ($node instanceof \Sabre\CalDAV\ICalendar) {
            $this->checkPrivileges($uri, Access::UNBIND);
        }
        parent::beforeUnbind($uri);
    }
}
