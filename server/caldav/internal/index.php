<?php

declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

header('Cache-Control: no-store');
try {
    $identity = \Calflex\Delegation::verify($_SERVER['HTTP_X_CALFLEX_PRINCIPAL'] ?? '', $_SERVER['REQUEST_METHOD'] ?? '', $_SERVER['REQUEST_URI'] ?? '', \Calflex\Delegation::keys(getenv('CALFLEX_DELEGATION_KEYS') ?: ''), time());
    if ($identity !== null) {
        $pdo = \Calflex\Database::connect(getenv('CALFLEX_DATABASE_URL') ?: '');
        if (\Calflex\Delegation::accept($pdo, $identity)) {
            \Calflex\Service::run(\Calflex\Service::create($pdo, $identity['p']));
            return;
        }
    }
} catch (\Throwable) {
    // Do not expose configuration, PDO errors, headers or request content.
}
error_log('caldav delegation_denied');
http_response_code(401);
header('Content-Type: text/plain; charset=utf-8');
echo "Unauthorized\n";
