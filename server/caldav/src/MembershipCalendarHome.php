<?php

declare(strict_types=1);

namespace Calflex;

/**
 * E03-R08 — the calendar home, i.e. `/calendars/<users.id>/`.
 *
 * The backend's `getCalendarsForUser` returns one entry per membership row, so
 * the home lists exactly the collections the acting user belongs to. A
 * collection that is not in this listing is unreachable through the home, which
 * is why every method and every href below a removed member's calendar answers
 * 404 rather than 403.
 *
 * SabreDAV's own `CalendarHome` builds `SharedCalendar` nodes for a backend
 * that supports sharing; this one builds `MembershipCalendar` nodes instead, so
 * the ACL comes from the membership role.
 */
final class MembershipCalendarHome extends \Sabre\CalDAV\CalendarHome
{
    /**
     * @param string $name
     *
     * @return \Sabre\DAV\INode
     */
    public function getChild($name)
    {
        foreach ($this->calendars() as $calendar) {
            if ($calendar['uri'] === $name) {
                return $this->calendarNode($calendar);
            }
        }

        // Special nodes (inbox, outbox, notifications) and subscriptions.
        return parent::getChild($name);
    }

    /** @return list<\Sabre\DAV\INode> */
    public function getChildren()
    {
        $nodes = [];
        foreach ($this->calendars() as $calendar) {
            $nodes[] = $this->calendarNode($calendar);
        }
        foreach (parent::getChildren() as $child) {
            // Skip the vendor calendar nodes: those already have a membership one.
            if (!$child instanceof \Sabre\CalDAV\Calendar) {
                $nodes[] = $child;
            }
        }

        return $nodes;
    }

    /** @return list<array<string, mixed>> */
    private function calendars(): array
    {
        /** @var list<array<string, mixed>> $calendars */
        $calendars = $this->caldavBackend->getCalendarsForUser($this->principalInfo['uri']);

        return $calendars;
    }

    /** @param array<string, mixed> $calendar */
    private function calendarNode(array $calendar): MembershipCalendar
    {
        return new MembershipCalendar($this->caldavBackend, $calendar, Access::role($calendar));
    }
}
