<?php

declare(strict_types=1);

namespace Calflex;

final class Database
{
    public static function connect(string $url): \PDO
    {
        $parts = parse_url($url);
        if ($parts === false || ($parts['scheme'] ?? '') !== 'postgresql' || !isset($parts['host'], $parts['path'], $parts['user'], $parts['pass'])) {
            throw new \RuntimeException('Invalid database configuration');
        }
        $host = $parts['host'];
        $port = $parts['port'] ?? 5432;
        $database = rawurldecode(substr($parts['path'], 1));
        if (!preg_match('/^[a-zA-Z0-9_.-]+$/D', $host) || !preg_match('/^[a-zA-Z0-9_-]+$/D', $database)) {
            throw new \RuntimeException('Invalid database configuration');
        }
        return new \PDO("pgsql:host=$host;port=$port;dbname=$database", rawurldecode($parts['user']), rawurldecode($parts['pass']), [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_EMULATE_PREPARES => false]);
    }
}
