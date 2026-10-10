<?php

declare(strict_types=1);

namespace Calflex\Tests;

use Calflex\Delegation;

final class Signer
{
    public static function header(string $keyId, string $key, string $principal, string $method, string $target, ?int $timestamp = null, ?string $nonce = null): string
    {
        $t = $timestamp ?? time();
        $n = $nonce ?? Delegation::encode(random_bytes(16));
        $s = Delegation::encode(hash_hmac('sha256', "calflex-delegation-v1\n$method\n$target\n$principal\n$t\n$n", $key, true));
        return "v=1; k=$keyId; p=$principal; t=$t; n=$n; s=$s";
    }
}
