# CalDAV service — E03-R01

PHP 8.4 / SabreDAV 4.7.1, PostgreSQL PDO, FrankenPHP classic mode.
`composer.lock` must match `server/api/sabredav/record.json`; unit tests reject
version or commit drift. Schema creation stays in the API migration chain.

## Trust boundary

- Public `:8080` has a standalone entry, loads no delegation code or database,
  and ignores all authentication headers. `GET /healthz` is DB-independent;
  all other paths return the same 401. Discovery is E03-R02.
- Internal `172.30.91.2:8081` binds only to the dedicated `delegation` network.
  Only API, CalDAV and the one-off test service join. No published port or proxy
  route reaches it. Outer Caddy removes the delegation header on every route.
- Only delegated identity exists: no Basic/password/dev fallback. Strict header
  validation, canonical base64url, constant-time HMAC comparison, method/raw
  `REQUEST_URI` binding, ±60-second skew and all configured rotation keys.
  `p` must be UUIDv4. Duplicate key IDs, short keys and invalid config fail closed.
- Nonces are globally unique in Postgres, inserted with a 120-second TTL. Pruning,
  insert and user lookup are transactional; failed identity/replay leaves no
  writes. Signature failures never connect to the database. A nonce is consumed
  even if the authenticated DAV operation fails.
- All delegation failures are `401`, `Unauthorized\n`, `Cache-Control: no-store`.
  Only coarse denial/DAV-failure codes are logged. The wrapper invokes Sabre's
  method pipeline directly to serialize DAV preconditions and HTTP headers only, omitting exception
  messages, classes and traces. Fixed denial reasons distinguish malformed headers,
  unknown keys, signatures, skew, replay and unknown principals; exceptions log
  `delegation_error` without their details.
- Principal lookup/listing is restricted to the acting `public.users` row;
  principal data is read-only. ACL unauthenticated access is off and inaccessible
  nodes are hidden. Other users' homes/principals are 404. Ownership is Sabre's
  `principaluri`; membership integration, write guard and outbox remain R08–R10.
- CalDAV, ACL, Sync, PropertyStorage and the already-authenticated identity plugin
  are installed. No Browser, Locks, Scheduling, Sharing, export or CardDAV plugin.
  Every PDO table and sequence is schema-qualified; CRUD integration exercises
  PostgreSQL `lastInsertId('sabredav.calendars_id_seq')` and instance sequence.
- Container runs UID 10001, writable XDG paths, four PHP threads and a 256 MiB
  limit. The upstream binary retains its net-bind capability but both listeners
  use unprivileged ports; no added capabilities, root or sysctl changes.
- The Compose default key is public, local-development-only, never a production
  credential. Production must inject `CALFLEX_DELEGATION_KEYS` from D-19's secret
  store. Native HMAC/hash comparison only; no event-content crypto libraries.
  PHP's built-in sodium extension is not used by this service.

Human security approval is required before merge.

## Checks

```
composer install
composer format:check
composer lint
composer typecheck
composer test
composer audit
```

`composer test` runs only `tests/Unit` on the host. Test-only signing code is in
`autoload-dev`, not the runtime image. Three deterministic wire vectors are in
`tests/Fixtures/delegation-vectors.json` for the API implementation to reuse.
The IANA Europe/Berlin fixture comes from tzurl.org (Olson 2026d); all recurrence
filtering and timezone interpretation belongs to sabre/vobject.

From the repository root with rootless Podman: `make test-caldav` migrates, builds
and runs the one-off test image, then checks service logs without printing event
content. It uses only the API/CalDAV roles, creates fresh UUIDs, and cleans up its
rows. Run twice to check rerunnability. The suite includes real protocol CRUD,
ETag failures, home discovery, recurring-instance queries, sync-token changes,
all delegation failures, public header indifference, isolation and nonce pruning.
Its registry entry runs through `make verify-invariants` and `make verify`.
The stack-dependent suite and image must be exercised outside the sandbox; its
warm `make test-caldav` run took 21 s in review 1, with CalDAV RSS 43 MB
of its 256 MiB limit.
