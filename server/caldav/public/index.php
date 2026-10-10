<?php

declare(strict_types=1);

// Intentionally standalone: no autoloader, auth code or database connection.
header('Cache-Control: no-store');
header('Content-Type: text/plain; charset=utf-8');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET' && ($_SERVER['REQUEST_URI'] ?? '') === '/healthz') {
    echo "ok\n";
    return;
}
http_response_code(401);
echo "Unauthorized\n";
