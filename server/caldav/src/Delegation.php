<?php

declare(strict_types=1);

namespace Calflex;

final class Delegation
{
    /** @return array<string, string> */
    public static function keys(string $config): array
    {
        $keys = [];
        foreach (explode(',', $config) as $entry) {
            if (!preg_match('/^([A-Za-z0-9_-]{1,64}):([A-Za-z0-9+\/]+={0,2})$/D', $entry, $match)) {
                return [];
            }
            $key = base64_decode($match[2], true);
            if ($key === false || strlen($key) < 32 || isset($keys[$match[1]]) || base64_encode($key) !== $match[2]) {
                return [];
            }
            $keys[$match[1]] = $key;
        }
        return $keys;
    }

    /** @param array<string, string> $keys
     * @return array{p: string, n: string}|null
     */
    public static function verify(string $header, string $method, string $target, array $keys, int $now): ?array
    {
        $fields = [];
        foreach (explode(';', $header) as $part) {
            if (!preg_match('/^([vkptns])=([^\s;=]+)$/D', trim($part), $match) || isset($fields[$match[1]])) {
                return null;
            }
            $fields[$match[1]] = $match[2];
        }
        if (count($fields) !== 6 || ($fields['v'] ?? '') !== '1' || !isset($fields['k'], $fields['p'], $fields['t'], $fields['n'], $fields['s'])) {
            return null;
        }
        ['k' => $k, 'p' => $p, 't' => $t, 'n' => $n, 's' => $s] = $fields;
        if (!isset($keys[$k]) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $p) || !preg_match('/^[0-9]{1,12}$/D', $t) || !preg_match('/^[A-Za-z0-9_-]{22}$/D', $n) || !preg_match('/^[A-Za-z0-9_-]{43}$/D', $s)) {
            return null;
        }
        // Reject non-canonical base64url representations, including unused low bits.
        foreach ([$n, $s] as $encoded) {
            $decoded = base64_decode(strtr($encoded, '-_', '+/'), true);
            if ($decoded === false || self::encode($decoded) !== $encoded) {
                return null;
            }
        }
        $message = "calflex-delegation-v1\n$method\n$target\n$p\n$t\n$n";
        if (!hash_equals(self::encode(hash_hmac('sha256', $message, $keys[$k], true)), $s) || abs($now - (int) $t) > 60) {
            return null;
        }
        return ['p' => $p, 'n' => $n];
    }

    public static function encode(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    /** @param array{p: string, n: string} $identity */
    public static function accept(\PDO $pdo, array $identity): bool
    {
        $pdo->beginTransaction();
        try {
            $pdo->exec('DELETE FROM public.delegation_nonces WHERE expires_at < now()');
            $insert = $pdo->prepare("INSERT INTO public.delegation_nonces (nonce, expires_at) VALUES (?, now() + interval '120 seconds')");
            $insert->execute([$identity['n']]);
            $user = $pdo->prepare('SELECT id FROM public.users WHERE id = ?');
            $user->execute([$identity['p']]);
            if (!$user->fetchColumn()) {
                $pdo->rollBack();
                return false;
            }
            $pdo->commit();
            return true;
        } catch (\PDOException $e) {
            $pdo->rollBack();
            if ($e->getCode() === '23505') {
                return false;
            }
            throw $e;
        }
    }
}
