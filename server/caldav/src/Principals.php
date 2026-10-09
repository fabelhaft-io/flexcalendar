<?php

declare(strict_types=1);

namespace Calflex;

use Sabre\DAVACL\PrincipalBackend\AbstractBackend;

final class Principals extends AbstractBackend
{
    public function __construct(private \PDO $pdo, private string $principal)
    {
    }

    /** @return list<array{uri: string}> */
    public function getPrincipalsByPrefix($prefixPath)
    {
        $principal = $this->getPrincipalByPath($this->principal);
        return $prefixPath === 'principals' && $principal ? [$principal] : [];
    }

    /** @return array{uri: string}|null */
    public function getPrincipalByPath($path)
    {
        if ($path !== $this->principal) {
            return null;
        }
        $query = $this->pdo->prepare('SELECT id FROM public.users WHERE id = ?');
        $query->execute([substr($path, strlen('principals/'))]);
        return $query->fetchColumn() ? ['uri' => $path] : null;
    }

    public function updatePrincipal($path, \Sabre\DAV\PropPatch $propPatch): void
    {
        throw new \Sabre\DAV\Exception\Forbidden('Read-only principal');
    }

    /** @param array<string, string> $searchProperties
     * @return list<string>
     */
    public function searchPrincipals($prefixPath, array $searchProperties, $test = 'allof')
    {
        return [];
    }

    /** @return list<string> */
    public function getGroupMemberSet($principal)
    {
        return [];
    }

    /** @return list<string> */
    public function getGroupMembership($principal)
    {
        return [];
    }

    /** @param list<string> $members */
    public function setGroupMemberSet($principal, array $members): void
    {
        throw new \Sabre\DAV\Exception\Forbidden('Read-only principal');
    }
}
