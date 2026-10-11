<?php

declare(strict_types=1);

namespace Calflex;

/**
 * E03-R08 — the single copy of the role → privilege mapping.
 *
 * Access to a calendar collection is derived from the acting user's
 * `public.calendar_members` row, read at request time. This class is pure: it
 * turns a role string into WebDAV privilege names, and nothing else in the
 * service decides them.
 */
final class Access
{
    /** The key a SabreDAV calendar-info array carries the acting user's role under. */
    public const ROLE = 'calflex-role';

    public const VIEWER = 'viewer';
    public const EDITOR = 'editor';
    public const OWNER = 'owner';

    public const READ = '{DAV:}read';
    public const WRITE = '{DAV:}write';
    public const WRITE_CONTENT = '{DAV:}write-content';
    public const WRITE_PROPERTIES = '{DAV:}write-properties';
    public const BIND = '{DAV:}bind';
    public const UNBIND = '{DAV:}unbind';

    /**
     * Privileges on a calendar collection itself.
     *
     * The owner's set is deliberately spelled out instead of using the
     * `{DAV:}write` aggregate: that aggregate also contains `{DAV:}write-acl`,
     * and E03-R08 keeps every ACL change out of CalDAV. Deleting the collection
     * is not expressible as a privilege on the node at all (the DAVACL plugin
     * checks `{DAV:}unbind` on the *parent*), so it is additionally enforced in
     * the backend's `deleteCalendar`.
     *
     * `{DAV:}bind` and `{DAV:}unbind` are what the DAVACL plugin checks on a
     * calendar when an object below it is created, deleted or moved.
     *
     * @var array<string, list<string>>
     */
    private const COLLECTION = [
        self::VIEWER => [self::READ],
        self::EDITOR => [self::READ, self::WRITE_CONTENT, self::BIND, self::UNBIND],
        self::OWNER => [self::READ, self::WRITE_CONTENT, self::BIND, self::UNBIND, self::WRITE_PROPERTIES],
    ];

    /**
     * Privileges on the calendar objects inside a calendar. An editor writes,
     * updates and deletes objects, so it gets the same object set as the owner;
     * both are still confined by the E03-R09 Private skeleton guard, which is
     * what keeps dead object properties out of a Private collection.
     *
     * @var array<string, list<string>>
     */
    private const OBJECTS = [
        self::VIEWER => [self::READ],
        self::EDITOR => [self::READ, self::WRITE],
        self::OWNER => [self::READ, self::WRITE],
    ];

    /** @return list<string> */
    public static function collection(string $role): array
    {
        return self::known(self::COLLECTION, $role);
    }

    /** @return list<string> */
    public static function objects(string $role): array
    {
        return self::known(self::OBJECTS, $role);
    }

    /**
     * The acting user's role out of a SabreDAV calendar-info array. A calendar
     * the backend did not stamp with a membership role has no privileges at
     * all: fail closed rather than guess.
     *
     * @param array<string, mixed> $calendarInfo
     */
    public static function role(array $calendarInfo): string
    {
        $role = $calendarInfo[self::ROLE] ?? null;
        if (!is_string($role) || !in_array($role, [self::VIEWER, self::EDITOR, self::OWNER], true)) {
            throw new \RuntimeException('Calendar collection without a membership role');
        }

        return $role;
    }

    public static function canWriteObjects(string $role): bool
    {
        return self::EDITOR === $role || self::OWNER === $role;
    }

    public static function canWriteProperties(string $role): bool
    {
        return self::OWNER === $role;
    }

    public static function canDeleteCollection(string $role): bool
    {
        return self::OWNER === $role;
    }

    /**
     * @param array<string, list<string>> $map
     *
     * @return list<string>
     */
    private static function known(array $map, string $role): array
    {
        if (!isset($map[$role])) {
            throw new \InvalidArgumentException('Unknown calendar role');
        }

        return $map[$role];
    }
}
