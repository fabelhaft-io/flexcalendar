<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\DAV\PropPatch;

final class GuardedProperties extends \Sabre\DAV\PropertyStorage\Backend\PDO
{
    public function __construct(\PDO $pdo, private readonly WriteGuard $guard)
    {
        parent::__construct($pdo);
    }

    public function propPatch($path, PropPatch $propPatch): void
    {
        $parts = explode('/', trim($path, '/'));
        if ($parts[0] === 'calendars' && count($parts) >= 3) {
            $this->guard->properties($parts[2], $propPatch->getMutations(), count($parts) === 3);
        }
        parent::propPatch($path, $propPatch);
    }
}
