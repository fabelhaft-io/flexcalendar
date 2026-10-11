<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\CalDAV\Backend\BackendInterface;

/**
 * E03-R08 — a calendar collection whose privileges come from the acting user's
 * `public.calendar_members` role.
 *
 * SabreDAV's own `Calendar`/`SharedCalendar` derive the ACL from
 * `calendarinstances.principaluri` and `calendarinstances.access`. Those two
 * columns are not membership: a collection the acting user is only a member of
 * through the API is not an instance of theirs at all, and `ACCESS_READWRITE`
 * maps to the `{DAV:}write` aggregate, which would hand a sharee the
 * `{DAV:}write-properties` privilege E03-R08 reserves for the owner.
 */
final class MembershipCalendar extends \Sabre\CalDAV\Calendar
{
    /** @param array<string, mixed> $calendarInfo */
    public function __construct(BackendInterface $backend, array $calendarInfo, private readonly string $role)
    {
        parent::__construct($backend, $calendarInfo);
    }

    /**
     * The privileges the acting user has on the collection, which is also what
     * `{DAV:}current-user-privilege-set` advertises: a stock app draws a
     * viewer's calendar as read-only from exactly this.
     *
     * @return list<array{privilege: string, principal: string, protected: bool}>
     */
    public function getACL()
    {
        return $this->aces(Access::collection($this->role));
    }

    /**
     * The privileges on the objects inside the collection. SabreDAV copies this
     * onto every child node it hands out.
     *
     * @return list<array{privilege: string, principal: string, protected: bool}>
     */
    public function getChildACL()
    {
        return $this->aces(Access::objects($this->role));
    }

    /**
     * @param list<string> $privileges
     *
     * @return list<array{privilege: string, principal: string, protected: bool}>
     */
    private function aces(array $privileges): array
    {
        $principal = (string) $this->calendarInfo['principaluri'];
        $acl = [];
        foreach ($privileges as $privilege) {
            $acl[] = ['privilege' => $privilege, 'principal' => $principal, 'protected' => true];
        }

        return $acl;
    }
}
