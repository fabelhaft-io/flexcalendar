<?php

declare(strict_types=1);

namespace Calflex\Tests;

use Calflex\GuardedCalendars;

/**
 * Test-only seam override: throws inside the open transaction, right after the
 * object write and before the outbox insert, on the caller's own connection.
 * Loaded only from tests/Integration/OutboxTest.php; the runtime image copies
 * src/, public/, internal/ and the Caddyfile only.
 */
final class ThrowingCalendars extends GuardedCalendars
{
    /** @param array{0: mixed, 1: mixed} $calendarId */
    protected function afterObjectWrite(array $calendarId, string $objectUri): void
    {
        throw new \RuntimeException('afterObjectWrite failed');
    }
}
