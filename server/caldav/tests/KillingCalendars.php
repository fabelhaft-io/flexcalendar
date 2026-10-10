<?php

declare(strict_types=1);

namespace Calflex\Tests;

use Calflex\GuardedCalendars;

/**
 * Test-only seam override: dies with SIGKILL between the object write and the
 * outbox insert. Loaded only from tests/OutboxWriter.php; the runtime image
 * copies src/, public/, internal/ and the Caddyfile only.
 */
final class KillingCalendars extends GuardedCalendars
{
    protected function afterObjectWrite(): void
    {
        $pid = getmypid();
        if ($pid !== false && function_exists('posix_kill')) {
            posix_kill($pid, 9);
        }
        if ($pid !== false && function_exists('exec')) {
            exec('kill -9 ' . $pid);
        }
        // Unreachable when either kill worked: the parent asserts a signal, so
        // fail loudly rather than continuing with an unkilled process.
        exit(70);
    }
}
