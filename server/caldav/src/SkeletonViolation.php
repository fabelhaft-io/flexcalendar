<?php

declare(strict_types=1);

namespace Calflex;

final class SkeletonViolation extends \RuntimeException
{
    public readonly string $name;

    public function __construct(string $name)
    {
        $this->name = preg_match('/\A[A-Z][A-Z0-9-]{0,63}\z/', $name) === 1 ? $name : 'UNLISTED';
        parent::__construct('Private skeleton only');
    }
}
