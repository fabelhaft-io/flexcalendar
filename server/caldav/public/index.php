<?php

declare(strict_types=1);

// Intentionally standalone: no autoloader, no other file is loaded, no auth
// code and no database connection. StructureTest keeps it that way.
/**
 * Discovery target for a request URI, or null when the request is not the
 * RFC 6764 well-known endpoint.
 *
 * The target is the fixed constant `/`. It is never derived from `Host`, a
 * forwarded header or the request itself, so a query string is ignored rather
 * than reflected and there is nothing an open redirect could point at. The
 * request URI is the only input, so no header can change the answer.
 */
function calflex_discovery_target(string $requestUri): ?string
{
    return explode('?', $requestUri, 2)[0] === '/.well-known/caldav' ? '/' : null;
}

header('Cache-Control: no-store');
header('Content-Type: text/plain; charset=utf-8');

// Discovery: one exact path, one fixed target, for every method, without
// reading a header. Stock apps start with a PROPFIND, so the method is not
// part of the match.
$target = calflex_discovery_target($_SERVER['REQUEST_URI'] ?? '');
if (null !== $target) {
    header('Location: ' . $target, true, 301);
    return;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET' && ($_SERVER['REQUEST_URI'] ?? '') === '/healthz') {
    echo "ok\n";
    return;
}
http_response_code(401);
echo "Unauthorized\n";
