<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\CalDAV\ICalendar;
use Sabre\CalDAV\ICalendarObject;
use Sabre\DAV\ICollection;
use Sabre\DAV\IFile;
use Sabre\DAV\Server;
use Sabre\DAV\ServerPlugin;
use Sabre\Uri;
use Sabre\VObject\Reader;

/**
 * E03-R11 — the Private value backstop, ahead of SabreDAV's own validation.
 *
 * `GuardPlugin` runs the guard's object checks from the `beforeCreateFile` and
 * `beforeWriteContent` events at a priority below Sabre\CalDAV\Plugin's own
 * (90 against its default 100), so a Private collection refuses a bad object
 * with the `403` `cf:private-skeleton-only` precondition before the CalDAV
 * plugin can answer with a `4xx` of its own. The one that matters: `sabre/vobject`'s
 * CalDAV-profile validation calls two `VEVENT`s that carry different `UID`s a
 * level-3 error, and `validateICalendar` turns that into a `415` — a status the
 * epic does not give; the refusal is the `403`, so the guard has to be what
 * answers.
 *
 * The backend guard in {@see GuardedCalendars} stays, unchanged, as the backstop
 * for everything that does not emit these events: a `COPY` and the copy half of
 * a cross-collection `MOVE` (`Sabre\DAV\Tree::copyNode` calls `createFile` on
 * the collection directly), and a direct backend call that skips the tree. Both
 * call the same function; here it sees the body as it arrived, before SabreDAV's
 * repair, and there it sees it as SabreDAV left it — which is why a `PUT` with
 * no `UID` is refused either way.
 *
 * Only a Private calendar is checked. The collection is read from the request
 * path, the same string `GuardedCalendars::uri()` reads from the store, and a
 * URI that is not a calendar id is left alone. A body Sabre's own reader cannot
 * parse, or that is not a `VCALENDAR`, is not a Private-object question: it is
 * left to `validateICalendar` and keeps the `415` a broken body has always got.
 */
final class GuardPlugin extends ServerPlugin
{
    public function __construct(private readonly WriteGuard $guard)
    {
    }

    public function getPluginName(): string
    {
        return 'calflex-private-guard';
    }

    public function initialize(Server $server): void
    {
        $server->on('beforeCreateFile', [$this, 'beforeCreateFile'], 90);
        $server->on('beforeWriteContent', [$this, 'beforeWriteContent'], 90);
    }

    /**
     * A `PUT` to a name the collection does not hold, a `COPY` in and the copy
     * half of a cross-collection `MOVE` all reach the backend through
     * `createCalendarObject`; the hook sees the two `PUT` shapes, which is where
     * SabreDAV's CalDAV validation can answer first. `COPY`/`MOVE` do not emit
     * this event and stay the backend's.
     *
     * @param resource|string $data
     */
    public function beforeCreateFile(string $path, &$data, ICollection $parentNode, bool &$modified): void
    {
        if (!$parentNode instanceof ICalendar) {
            return;
        }
        $text = $this->text($path, $data);
        if ($text !== null) {
            $this->refuse(static fn () => PrivateSkeleton::createObject(self::objectName($path), $text));
        }
    }

    /**
     * @param resource|string $data
     */
    public function beforeWriteContent(string $path, IFile $node, &$data, bool &$modified): void
    {
        if (!$node instanceof ICalendarObject) {
            return;
        }
        $text = $this->text($path, $data);
        if ($text !== null) {
            $stored = PrivateSkeleton::storedUid($node->get());
            $this->refuse(static fn () => PrivateSkeleton::updateObject($stored, $text));
        }
    }

    /**
     * The body when the guard should see it, or `null` to leave the write to
     * SabreDAV's own validation. The collection is read first, so a Shared or
     * Published write never reaches the parser. A resource becomes a string
     * exactly as `Sabre\CalDAV\Plugin::validateICalendar` does it, so the
     * handlers after this one still receive a body.
     *
     * @param resource|string $data
     */
    private function text(string $path, mixed &$data): ?string
    {
        if (!$this->guard->privateCollection(self::collection($path))) {
            return null;
        }
        if (is_resource($data)) {
            $contents = stream_get_contents($data);
            if ($contents === false) {
                return null;
            }
            $data = $contents;
        }
        if (!is_string($data)) {
            return null;
        }
        try {
            if (Reader::read($data)->name !== 'VCALENDAR') {
                return null;
            }
        } catch (\Throwable) {
            return null;
        }

        return $data;
    }

    /** @param \Closure(): void $check */
    private function refuse(\Closure $check): void
    {
        try {
            $check();
        } catch (SkeletonViolation $violation) {
            throw new PrivateSkeletonOnly($violation->name);
        }
    }

    /** The calendar id of a DAV path like `calendars/<principal>/<calendar>/<object>.ics`. */
    private static function collection(string $path): string
    {
        return basename(Uri\split($path)[0]);
    }

    /** The object name, the last path segment, exactly as SabreDAV stores it. */
    private static function objectName(string $path): string
    {
        return Uri\split($path)[1];
    }
}
