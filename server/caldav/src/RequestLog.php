<?php

declare(strict_types=1);

namespace Calflex;

/**
 * E05-R10: the internal listener's request log.
 *
 * One line per request, built from fixed fields only: the method (reduced to a
 * fixed allow-list, everything else is `OTHER`), the final status and the
 * correlation ID the API sent in `X-Request-Id`. No path, no query string, no
 * header value, no body — this service stores event content and no log line may
 * carry any (INV-01, INV-07).
 *
 * An inbound ID is believed only when it is exactly a lowercase UUIDv4; anything
 * else becomes `-`, so a hostile header cannot inject a line break or a second
 * log entry.
 */
final class RequestLog
{
    /** The methods the service can answer; nothing else is ever logged. */
    private const METHODS = [
        'GET', 'HEAD', 'OPTIONS',
        'PROPFIND', 'PROPPATCH', 'REPORT',
        'PUT', 'DELETE', 'POST',
        'MKCOL', 'MKCALENDAR', 'MOVE', 'COPY',
    ];

    private const UUID_V4 = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/';

    /** The method to log; anything outside the allow-list is `OTHER`. */
    public static function method(string $method): string
    {
        $upper = strtoupper($method);

        return in_array($upper, self::METHODS, true) ? $upper : 'OTHER';
    }

    /** The API's correlation ID, or `-` when it is absent or not a v4 UUID. */
    public static function correlationId(string $value): string
    {
        return preg_match(self::UUID_V4, $value) === 1 ? $value : '-';
    }

    /** The one access line per request. */
    public static function request(string $method, int $status, string $correlationId): void
    {
        error_log(sprintf('caldav request %s %d %s', $method, $status, $correlationId));
    }

    /** A delegation refusal, beside the access line and with the same ID. */
    public static function delegation(string $reason, string $correlationId): void
    {
        $entry = $reason === 'delegation_error' ? 'delegation_error' : 'delegation_denied ' . $reason;

        error_log(sprintf('caldav %s %s', $entry, $correlationId));
    }
}
