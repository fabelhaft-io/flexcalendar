<?php

declare(strict_types=1);

namespace Calflex;

final class Structure
{
    /** @param array<string, mixed> $lock
     * @param array{package: string, tag: string, commit: string} $record
     */
    public static function matchesRecord(array $lock, array $record): bool
    {
        foreach ($lock['packages'] ?? [] as $package) {
            if ($package['name'] === $record['package']) {
                return $package['version'] === $record['tag'] && $package['source']['reference'] === $record['commit'];
            }
        }
        return false;
    }

    public static function classic(string $config): bool
    {
        $code = preg_replace('/#[^\n]*/', '', $config) ?? '';
        return !preg_match('/\bworker\b/i', $code);
    }
}
