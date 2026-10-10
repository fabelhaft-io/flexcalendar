<?php

declare(strict_types=1);

namespace Calflex;

final class Authenticated implements \Sabre\DAV\Auth\Backend\BackendInterface
{
    public function __construct(private string $principal)
    {
    }

    /** @return array{bool, string} */
    public function check(\Sabre\HTTP\RequestInterface $request, \Sabre\HTTP\ResponseInterface $response)
    {
        return [true, $this->principal];
    }

    public function challenge(\Sabre\HTTP\RequestInterface $request, \Sabre\HTTP\ResponseInterface $response): void
    {
    }
}
