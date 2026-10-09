<?php

declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

header('Cache-Control: no-store');
$reason = 'delegation_error';
try {
    $keys = \Calflex\Delegation::keys(getenv('CALFLEX_DELEGATION_KEYS') ?: '');
    if ($keys === []) {
        throw new \RuntimeException('Invalid delegation configuration');
    }
    $identity = \Calflex\Delegation::verify($_SERVER['HTTP_X_CALFLEX_PRINCIPAL'] ?? '', $_SERVER['REQUEST_METHOD'] ?? '', $_SERVER['REQUEST_URI'] ?? '', $keys, time());
    $reason = $identity['reason'];
    if (isset($identity['p'], $identity['n'])) {
        $pdo = \Calflex\Database::connect(getenv('CALFLEX_DATABASE_URL') ?: '');
        $reason = \Calflex\Delegation::accept($pdo, $identity);
        if ($reason === 'accepted') {
            \Calflex\Service::run(\Calflex\Service::create($pdo, $identity['p']));
            return;
        }
    }
} catch (\Throwable) {
    $reason = 'delegation_error';
    // Do not expose configuration, PDO errors, headers or request content.
}
error_log('caldav ' . ($reason === 'delegation_error' ? $reason : 'delegation_denied ' . $reason));
http_response_code(401);
header('Content-Type: text/plain; charset=utf-8');
echo "Unauthorized\n";
