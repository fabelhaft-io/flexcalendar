# CalDAV service — E03-R01 / E03-R09

PHP 8.4 / SabreDAV 4.7.1, PostgreSQL PDO, FrankenPHP classic mode.
`composer.lock` must match `server/api/sabredav/record.json`; unit tests reject
version or commit drift. Schema creation stays in the API migration chain.

## Trust boundary

- Public `:8080` has a standalone entry, loads no delegation code or database,
  and ignores all authentication headers. `GET /healthz` is DB-independent;
  exactly `/.well-known/caldav` answers `301` with `Location: /`, every other
  path returns the same 401.
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
  `principaluri`; what the acting user may reach is their
  `public.calendar_members` row, read per request (E03-R08 below).
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

## Discovery (E03-R02)

The exact path `/.well-known/caldav` answers `301` with `Location: /` on the
public listener, for `GET`, `HEAD`, `OPTIONS` and `PROPFIND`, with
`Cache-Control: no-store` and no body. The match is one small function in the
standalone entry, and the target is the fixed service root: it is never taken
from `Host`, a forwarded header or the request, so a query string is ignored
rather than reflected, the same request with no header, a valid delegation
header or garbage produces byte-identical responses, and nothing is logged.
`/.well-known/caldav/`, `/.well-known/CALDAV`, `/.well-known/caldavx`,
`/.well-known/carddav`, `//.well-known/caldav` and `/x/.well-known/caldav` stay
401.

On the internal listener the tree root answers `{DAV:}current-user-principal`,
the principal node answers `{DAV:}principal-URL` and
`{urn:ietf:params:xml:ns:caldav}calendar-home-set`, and the home lists the
collections: `/principals/<users.id>/`, `/calendars/<users.id>/`,
`/calendars/<users.id>/<calendars.id>/`. Unit tests cover the match and the
redirect over a real HTTP server; `tests/Integration/DiscoveryTest.php` runs the
same sequence over the listener, with hrefs compared whole, and proves the
redirect on the public listener without a header and with a garbage one.
Stock-app behaviour itself is not asserted here: E15-R05 checks that on staging.

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

## Private write guard (E03-R09)

The CalDAV PDO backend guards stored object bytes (including COPY and cross-collection
MOVE), collection creation (MKCALENDAR and extended MKCOL) and collection PROPPATCH.
The PropertyStorage PDO backend rejects all object dead properties in Private
collections. The pure allow-list uses sabre/vobject, not a new recurrence engine. It requires
full input consumption and rejects property groups not listed by E03-R09.
Every VEVENT requires exactly one lowercase SHA-256 envelope hash. No event-content
crypto or body logging is added. Violations serialize only a fixed precondition and
an offending parsed name; names outside `[A-Z][A-Z0-9-]{0,63}` become `UNLISTED`.
Collection XML names are reduced to uppercase local names before that check.
The guard checks names, parameters, components and the listed fixed values, not
the free-text values of allowed properties (`UID`, `PRODID`, a `TZID` parameter,
`TZURL`, `X-LIC-LOCATION`, `TZNAME`).
A `VTIMEZONE` from tzurl.org carries `X-PROLEPTIC-TZNAME`, which the guard rejects
(the test fixture removes it).

Mode is looked up from public.calendars per backend call on the service connection.
A missing row or non-UUID collection URI means Private (fail closed); database
errors propagate without writes. Only explicit Shared/Published modes bypass the
guard. Empty creation properties are allowed; displayname, if supplied, must be
`Private calendar`. No rule beyond E03-R09's table is imposed by the guard.

Unit tests exercise the allow-list and injected modes. Integration GuardTest
exercises delegated requests, persistence after denials, copy/move, collection
and object properties, malformed-body redaction and marker responses/headers.
`make test-caldav` also scans service logs for guard markers; run it twice.

## Change outbox (E03-R10)

Every successful `createCalendarObject`, `updateCalendarObject` and
`deleteCalendarObject` appends one `public.caldav_changes` row holding the
collection's UUID (the API's `public.calendars.id`, taken from the instance URI),
`sync_token`, the object's `UID` and `created`/`updated`/`deleted`. Nothing else
from the object is copied: the outbox carries no event content (INV-01).

The row is written in **one transaction** with the object, SabreDAV's own
`calendarchanges` row and the `calendars.synctoken` bump, on one connection. The
E03-R09 guard checks the body first, and the collection must map to a
`public.calendars` row; then `BEGIN`, `SELECT synctoken … FOR UPDATE` on the
calendar row (serializing writers so two concurrent changes cannot record the
same token), the parent write, the outbox insert, `COMMIT`; any throwable rolls
back and is rethrown.

`sync_token` is the number `sync-collection` reports for the change, i.e. the
incremented `calendars.synctoken`, which is `calendarchanges.synctoken + 1` (that
column keeps the pre-increment value N). E05-R08 and E07 hand this number to
clients as "changed up to".

A collection without a `public.calendars` row (or without a UUID URI) is refused
before any write with `403` and a `cf:unmapped-collection` precondition, because
the outbox row's foreign key could not be satisfied; the object write and the
outbox row are never split. E03-R08 makes that row the membership as well, so
over HTTP such a collection is in nobody's home and the request is a `404`
before this backend runs: the refusal is what a backend call that reaches the
collection without going through the tree still gets. `deleteCalendarObject`
reads the `UID` before the delete; a `PUT` body without `UID` is stored with a
`sabre-vobject-<uuid>` `UID`
by SabreDAV's repair before the outbox sees it, so that generated `UID` is what
the row records. The protected no-op `afterObjectWrite($calendarId, $objectUri)`
seam runs between the parent write and the outbox insert and is overridden only
by `tests/KillingCalendars.php` so `tests/Integration/OutboxTest.php` can prove
the all-or-nothing behaviour; `tests/ThrowingCalendars.php` overrides it to prove
the rollback. `tests/OutboxWriter.php` is a test-only script, not part of the
runtime image.

## Access (E03-R08)

Access follows `public.calendar_members`, read from Postgres on every request
with no cache. SabreDAV's `sabredav.calendarinstances` keeps no membership copy:
the API owns the table, so there is nothing to keep in sync, and permissions
never change through CalDAV.

- The home **is** the membership. `GuardedCalendars::getCalendarsForUser` returns
  one entry per `public.calendar_members` row of the acting user, so a member
  sees every calendar they belong to at `/calendars/<users.id>/<calendars.id>/`
  and no others. A collection that is not a row of theirs is not in their home:
  every method on any of its hrefs answers `404`, never `403`.
- Roles map to privileges, in one place (`Calflex\Access`, and nowhere else):
  `viewer` has `{DAV:}read`; `editor` adds `{DAV:}write-content` and
  `{DAV:}write-properties` on the objects and `{DAV:}bind`/`{DAV:}unbind` on the
  collection, which is how it creates and deletes them; `owner` adds
  `{DAV:}write-properties` on the collection and may delete the collection. Both
  privilege sets are spelled out instead of using the `{DAV:}write` aggregate:
  that aggregate contains `{DAV:}write-acl` for any node implementing `IACL`,
  which a calendar and a calendar object both do. An object's
  `{DAV:}write-properties` is not a grant of plaintext: it is what lets a
  `PROPPATCH` on the object reach the E03-R09 guard, which refuses every dead
  property of a Private object. A stock app draws the collection read-only for a
  viewer from exactly this set.
- `ACL` is refused with `403` for every role, the owner included, and so is a
  `POST` that reaches a calendar collection (the sharing extension's
  `share-resource`) until E03-R05 reconciles shares in Phase 4. The API is the
  only writer of `calendar_members`.
- Two layers enforce it. The node ACLs above decide over HTTP, and the backend
  re-reads the role in every write method (`GuardedCalendars::createCalendarObject`,
  `updateCalendarObject`, `deleteCalendarObject`, `updateCalendar`,
  `deleteCalendar`, `createCalendar`), in front of the E03-R09 guard and the
  E03-R10 transaction, so a path that skips the ACL plugin is still refused. The
  ACL layer answers first over HTTP, so that second layer is pinned directly by
  `tests/Integration/BackendAccessTest.php`; `tests/Unit/MembershipPluginTest.php`
  pins the extra `{DAV:}unbind` check the plugin makes on the collection node
  itself, which is what stops a viewer before the backend sees the delete.
- Authorization answers before the write guard. Over HTTP a `PUT` body the
  E03-R09 guard would reject is refused for a viewer by the ACL layer first
  (`need-privileges`, no `cf:private-skeleton-only`), and only an editor or the
  owner sees the guard's precondition. A direct backend call gets the role check
  first for the same reason, which is what `BackendAccessTest` pins.
