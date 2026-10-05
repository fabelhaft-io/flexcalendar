<?php

declare(strict_types=1);

/**
 * --- calendar-flex CalDAV service: local-stack skeleton (E02-R03) -----------
 *
 * `make dev` runs this so the stack has a real service at
 * https://caldav.localhost:<port>/ from day one. E03-R01 replaces this file
 * with the SabreDAV service (D-02, server/caldav/README.md), and E04 gives it
 * the Postgres schema.
 *
 * Until then it answers liveness only: no CalDAV, no database, no event data.
 * It never logs and never returns event content (INV-01), and it links no
 * content-crypto library (INV-07).
 *
 * Answering PROPFIND/REPORT with a fabricated multistatus would be worse than
 * saying they are not implemented, so it does not.
 */

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if ($path === false || $path === null || $path === '') {
    $path = '/';
}

header('Content-Type: application/json; charset=utf-8');

$body = static function (array $payload): void {
    echo json_encode($payload, JSON_UNESCAPED_SLASHES), "\n";
};

// Readiness probe (infra/dev/compose.yaml).
if ($method === 'GET' && $path === '/healthz') {
    http_response_code(200);
    $body(['status' => 'ok', 'service' => 'caldav']);

    return;
}

if ($method === 'GET' && $path === '/') {
    http_response_code(200);
    $body([
        'service' => 'caldav',
        'status' => 'skeleton',
        'note' => 'The SabreDAV service arrives with E03-R01.',
    ]);

    return;
}

http_response_code(501);
$body([
    'service' => 'caldav',
    'status' => 'not implemented',
    'method' => $method,
    'note' => 'The SabreDAV service arrives with E03-R01.',
]);
