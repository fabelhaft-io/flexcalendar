<?php

declare(strict_types=1);

namespace Calflex;

final class WriteGuard
{
    /** What a collection URI is: the calendar id, i.e. `public.calendars.id`. */
    private const CALENDAR_ID = '/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i';

    /** @param \Closure(string): ?string $lookup */
    public function __construct(private readonly \Closure $lookup)
    {
    }

    public static function fromPdo(\PDO $pdo): self
    {
        return new self(static function (string $id) use ($pdo): ?string {
            $query = $pdo->prepare('SELECT mode FROM public.calendars WHERE id = ?');
            $query->execute([$id]);
            $mode = $query->fetchColumn();
            return is_string($mode) ? $mode : null;
        });
    }

    public function private(string $uri): bool
    {
        if (preg_match(self::CALENDAR_ID, $uri) !== 1) {
            return true;
        }
        // No cache, no fallback on DB errors. Only explicit non-private modes bypass.
        return !in_array(($this->lookup)($uri), ['shared', 'published'], true);
    }

    /**
     * E03-R11 — whether `$uri` is a calendar id the guard has a rule for, i.e.
     * a mapped Private collection. The pre-validation hook in {@see GuardPlugin}
     * is the one caller that can also be handed a URI that is not a calendar id
     * at all (the calendar home, an outbox), where the guard has no rule; those
     * are left to SabreDAV. Everything the backend sees is a mapped collection —
     * `GuardedCalendars::collection()` refuses the rest before the guard — so
     * this is only ever the hook's entry condition.
     */
    public function privateCollection(string $uri): bool
    {
        return preg_match(self::CALENDAR_ID, $uri) === 1 && $this->private($uri);
    }

    /**
     * E03-R09 plus E03-R11, for an object a Private collection does not hold yet
     * — `createCalendarObject`, and the `COPY`/cross-collection `MOVE` SabreDAV
     * turns into one. The name check is the one part that needs the object URI.
     */
    public function createObject(string $uri, string $objectUri, string $text): void
    {
        if ($this->private($uri)) {
            $this->check(static fn () => PrivateSkeleton::createObject($objectUri, $text));
        }
    }

    /**
     * E03-R09 plus E03-R11, for an object the collection already holds. The
     * stored `UID` is the authority the body must keep; it is read by the
     * caller, which owns the store, and never from the body.
     */
    public function updateObject(string $uri, string $text, ?string $storedUid): void
    {
        if ($this->private($uri)) {
            $this->check(static fn () => PrivateSkeleton::updateObject($storedUid, $text));
        }
    }

    /** @param array<string, mixed> $properties */
    public function properties(string $uri, array $properties, bool $collection = true): void
    {
        if ($this->private($uri)) {
            $this->check(static fn () => PrivateSkeleton::properties($properties, $collection));
        }
    }

    private function check(\Closure $check): void
    {
        try {
            $check();
        } catch (SkeletonViolation $violation) {
            throw new PrivateSkeletonOnly($violation->name);
        }
    }
}
