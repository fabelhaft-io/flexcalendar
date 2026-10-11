<?php

declare(strict_types=1);

namespace Calflex\Tests;

use Calflex\GuardedCalendars;

/**
 * Test-only seam override: reports what the open transaction has written so far
 * and then dies with SIGKILL, between the object write and the outbox insert.
 * Reported first, killed afterwards, so the parent can prove the seam sits
 * between the two writes rather than before both of them. Loaded only from
 * tests/OutboxWriter.php; the runtime image copies src/, public/, internal/ and
 * the Caddyfile only.
 *
 * The reported line carries no event content: only the object URI (a test UUID),
 * the stored etag, and row counts.
 */
final class KillingCalendars extends GuardedCalendars
{
    /** @param array{0: mixed, 1: mixed} $calendarId */
    protected function afterObjectWrite(array $calendarId, string $objectUri): void
    {
        $this->report($calendarId, $objectUri);
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

    /**
     * One line on stdout, inside the caller's transaction, on the writer's own
     * connection: the object row (present plus etag, so an update is told from
     * the old bytes), the calendar's sabredav.calendarchanges rows, the
     * collection's public.caldav_changes rows, and whether a transaction is open.
     *
     * @param array{0: mixed, 1: mixed} $calendarId
     */
    private function report(array $calendarId, string $objectUri): void
    {
        $object = $this->pdo->prepare('SELECT etag FROM ' . $this->calendarObjectTableName . ' WHERE calendarid = ? AND uri = ?');
        $object->execute([$calendarId[0], $objectUri]);
        $etag = $object->fetchColumn();

        $instance = $this->pdo->prepare('SELECT uri FROM ' . $this->calendarInstancesTableName . ' WHERE id = ? AND calendarid = ?');
        $instance->execute([$calendarId[1], $calendarId[0]]);
        $collection = $instance->fetchColumn();

        $state = [
            'object' => is_string($etag),
            'etag' => is_string($etag) ? $etag : null,
            'changes' => $this->count('SELECT count(*) FROM ' . $this->calendarChangesTableName . ' WHERE calendarid = ?', [$calendarId[0]]),
            'outbox' => is_string($collection)
                ? $this->count('SELECT count(*) FROM public.caldav_changes WHERE calendar_id = ?', [$collection])
                : -1,
            'transaction' => $this->pdo->inTransaction(),
        ];
        echo 'SEAM ' . json_encode($state, JSON_THROW_ON_ERROR) . "\n";
        fflush(STDOUT);
    }

    /** @param list<mixed> $parameters */
    private function count(string $sql, array $parameters): int
    {
        $statement = $this->pdo->prepare($sql);
        $statement->execute($parameters);
        return (int) $statement->fetchColumn();
    }
}
