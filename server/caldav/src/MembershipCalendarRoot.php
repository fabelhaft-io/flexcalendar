<?php

declare(strict_types=1);

namespace Calflex;

/**
 * E03-R08 — the `/calendars` root, handing out `MembershipCalendarHome` nodes
 * so every collection below it carries a membership-derived ACL.
 *
 * `getChildForPrincipal` is the only way SabreDAV builds a calendar home, so
 * this is the single swap point.
 */
final class MembershipCalendarRoot extends \Sabre\CalDAV\CalendarRoot
{
    /**
     * @param array{uri: string} $principal
     *
     * @return \Sabre\DAV\INode
     */
    public function getChildForPrincipal(array $principal)
    {
        return new MembershipCalendarHome($this->caldavBackend, $principal);
    }
}
