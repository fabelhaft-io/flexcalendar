# E06 — Sharing, feeds, stock-app onboarding

| | |
|---|---|
| Phase | 3 (R02, R09); 4 (R01, R03–R06, R08); R07 deferred, per ADR 0003 |
| Status | R02 is ready and R09 waits for E12-R01 (Phase 3, planning of 2026-10-12); the Phase 4 requirements wait for M1 |
| Executor | `agent+review` (credentials, ACLs, feed tokens), `human` for signing |
| Depends on | E03-R01, E04, E05-R03; each requirement names the rest; for Phase 4 also E03-R03, E03-R05, E03-R06 |
| Spec | `01` § Sharing model, `03`, `05` risks 6 and 9, ADR 0001 § Published feeds |

## Goal

Per-user accounts sharing calendar collections (the model the docs recommend), read-only feeds, and the onboarding flows that bring stock apps in.

## Requirements

### E06-R01 · Invite by email   `agent`
An owner MUST be able to invite by email with role `viewer|editor`. The invite is a single-use, expiring token, delivered through E08-R06 SMTP.
- Accept: accepting creates a `calendar_members` row and updates the ACL (E03-R08); an expired, reused or wrong-account token is rejected; the owner can revoke pending invites.
- Deps: E08-R06.

### E06-R02 · Role management and removal   `agent`
Owners MUST be able to change roles and remove members. Removal revokes CalDAV access immediately.
- Accept: a removed member's device credential gets 404 on the collection on its next request.
- Notes: for Private calendars, removal also starts a new key epoch (E13-R05). Device credentials exist from Phase 4; in Phase 3 the check is that the removed member's API calls get 404.
- Deps: E05-R03.

### E06-R03 · Apple sharing reconciliation   `agent+review`
Shares created through Apple Calendar's "Add Person…" (E03-R05) MUST be mapped into `invitations`/`calendar_members`. If they can't be mapped (for example, the invitee has no account), they're converted into an email invite. Because the API model is the source of truth, a share that exists only in CalDAV is never left in place.
- Accept: a device test (E15) shares from an iPhone and the invitee appears in the web sharing UI.
- Deps: E03-R05, E06-R01.

### E06-R04 · Device credentials   `agent+review`
Users MUST be able to create, label, list and revoke device app passwords (D-04). The password is shown exactly once.
- Accept: the list never exposes a hash or password; revocation takes effect on the next request; creation is written to `audit_log`.
- Deps: E03-R03.

### E06-R05 · `.mobileconfig` generation and signing   `agent` + `human`
The API MUST generate a per-device `.mobileconfig` (CalDAV payload: host, port 443, TLS, principal URL, handle, fresh app password) and sign it with the Apple Developer certificate held in the deploy environment.
- Accept: `security cms -D` on the output verifies; iOS shows a "Verified" profile; the profile is served once and not cached (`Cache-Control: no-store`).
- `human`: obtain the signing identity and put it in the secret store.

### E06-R06 · Published full-detail feeds   `agent+review`
Owners of a Shared calendar MUST be able to publish a read-only `.ics` feed at an unguessable capability URL (≥ 128-bit token, stored hashed), and to rotate and revoke it (ADR 0001 § Published feeds).
- Accept: the feed validates as RFC 5545; rotation invalidates the old URL immediately; a Private calendar cannot have a `full` feed (INV-08).
- Deps: E04-R03; the Phase 4 migration that lets `calendars.mode` hold `shared` and `published`, which no requirement owns yet.

### E06-R07 · Busy-only feeds from Private calendars   `agent`
**Deferred** until ADR 0001 open question 4 is answered. When it ships, the feed contains `VFREEBUSY`-style opaque blocks derived from the skeleton only.
- Status: Blocked (decision).
- Deps: E13-R03; the owner's answer to ADR 0001 open question 4.

### E06-R08 · Android onboarding page   `agent`
The web app MUST serve an "Add to Android" page with DAVx⁵ steps, a deep link into DAVx⁵ with the server URL pre-filled, and a fresh device credential.
- Notes: check which login URI schemes the current DAVx⁵ release supports before implementing. Don't assume a scheme.
- Accept: the deep link opens DAVx⁵ with the server pre-filled (verified by `human` in E15-R05).
- Notes: until the web app exists (Phase 5) this page is served by the API, as is the `.mobileconfig` download.
- Deps: E06-R04.

### E06-R09 · Invite by link or QR, no email   `agent+review`
Before SMTP exists (Phase 4), an owner MUST be able to invite through a link or QR code that the app shares through the OS share sheet or shows on screen (ADR 0003). The link carries a single-use, expiring token (≥ 128 bits, stored hashed) and the owner's identity-key fingerprint. Accepting it creates a pending `calendar_members` row. The owner's client seals the CCK once the invitee's keys exist and are verified (E13-R05, E13-R07).
- Accept: expired, reused and revoked tokens are rejected. Scanning the QR code in person marks both sides' keys as verified (D-15). A link invite leaves the member marked unverified until the two compare safety numbers, and the UI says so. The owner can revoke pending invites.
- Notes: both paths stay after R01 ships. The in-person QR flow is the strongest key verification we have.
- Notes: the server can't show the invitee the calendar's name, because it is encrypted (D-18). If the invite screen shows one, the owner's client puts it in the link's fragment, which is never sent to the server. Otherwise the invitee sees the name once they hold the CCK. The fingerprint and QR formats are in `spec/crypto.md` (E12-R01).
- Deps: E12-R01, E05-R03.
