<?php

declare(strict_types=1);

// Test-only writer process for OutboxTest. Runs the guarded backend against the
// test database as calflex_caldav, optionally through the KillingCalendars seam,
// so the suite can prove that the object write and the outbox write are atomic.
//
// Usage: php outbox-writer.php <config.json>, with the CALFLEX_DATABASE_URL of
// the CalDAV test role. Config keys: mode (create|update|delete), kill, calendar
// and instance (sabredav.calendarinstances columns), uri, base64 payload,
// principal (the acting users.id whose calendar_members row authorizes the
// write), and an optional barrier {dir, index, count} for the concurrency test.

require dirname(__DIR__) . '/vendor/autoload.php';

// The kill seam prints its state line and is then SIGKILLed, so nothing may sit
// in an output buffer when the process dies.
while (ob_get_level() > 0) {
    ob_end_flush();
}

/** @var array{mode: string, kill: bool, calendar: int, instance: int, uri: string, payload: string, principal: string, barrier?: array{dir: string, index: int, count: int}} $config */
$config = json_decode((string) file_get_contents((string) ($argv[1] ?? '')), true, 512, JSON_THROW_ON_ERROR);

$barrier = $config['barrier'] ?? null;
if ($barrier !== null) {
    file_put_contents($barrier['dir'] . '/ready-' . $barrier['index'], '1');
    $deadline = microtime(true) + 20;
    while (count((array) glob($barrier['dir'] . '/ready-*')) < $barrier['count']) {
        if (microtime(true) > $deadline) {
            exit(71);
        }
        usleep(2000);
    }
}

$payload = base64_decode($config['payload'], true);
if ($payload === false) {
    exit(72);
}

$pdo = \Calflex\Database::connect(getenv('CALFLEX_DATABASE_URL') ?: '');
$guard = \Calflex\WriteGuard::fromPdo($pdo);
$backend = $config['kill'] ? new \Calflex\Tests\KillingCalendars($pdo, $guard, $config['principal']) : new \Calflex\GuardedCalendars($pdo, $guard, $config['principal']);
$calendarId = [$config['calendar'], $config['instance']];

switch ($config['mode']) {
    case 'create':
        $backend->createCalendarObject($calendarId, $config['uri'], $payload);
        break;
    case 'update':
        $backend->updateCalendarObject($calendarId, $config['uri'], $payload);
        break;
    case 'delete':
        $backend->deleteCalendarObject($calendarId, $config['uri']);
        break;
    default:
        exit(73);
}

echo "ok\n";
