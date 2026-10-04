# E06 — Sharing, feeds, stock-app onboarding

| | |
|---|---|
| Phase | 1–2 |
| Status | Blocked on E05 |
| Executor | `agent+review` (credentials, ACLs, feed tokens), `human` for signing |
| Depends on | E03, E04, E05 |
| Spec | `01` § Sharing model, `03`, `05` risks 6 and 9, ADR 0001 § Published feeds |

## Goal

Per-user accounts sharing calendar collections (the model the docs recommend), read-only feeds, and the onboarding flows that bring stock apps in.

## Requirements

### E06-R01 · Invite by email   `agent`
An owner MUST be able to invite by email with role `viewer|editor`. The invite is a single-use, expiring token, delivered through E08-R06 SMTP.
- Accept: accepting creates a `calendar_members` row and updates the ACL (E03-R08); an expired, reused or wrong-account token is rejected; the owner can revoke pending invites.

### E06-R02 · Role management and removal   `agent`
Owners MUST be able to change roles and remove members. Removal revokes CalDAV access immediately.
- Accept: a removed member's device credential gets 404 on the collection on its next request.
- Notes: for Private calendars, removal also starts a new key epoch (E13-R05).

### E06-R03 · Apple sharing reconciliation   `agent+review`
Shares created through Apple Calendar's "Add Person…" (E03-R05) MUST be mapped into `invitations`/`calendar_members`. If they can't be mapped (for example, the invitee has no account), they're converted into an email invite. Because the API model is the source of truth, a share that exists only in CalDAV is never left in place.
- Accept: a device test (E15) shares from an iPhone and the invitee appears in the web sharing UI.

### E06-R04 · Device credentials   `agent+review`
Users MUST be able to create, label, list and revoke device app passwords (D-04). The password is shown exactly once.
- Accept: the list never exposes a hash or password; revocation takes effect on the next request; creation is written to `audit_log`.

### E06-R05 · `.mobileconfig` generation and signing   `agent` + `human`
The API MUST generate a per-device `.mobileconfig` (CalDAV payload: host, port 443, TLS, principal URL, handle, fresh app password) and sign it with the Apple Developer certificate held in the deploy environment.
- Accept: `security cms -D` on the output verifies; iOS shows a "Verified" profile; the profile is served once and not cached (`Cache-Control: no-store`).
- `human`: obtain the signing identity and put it in the secret store.

### E06-R06 · Published full-detail feeds   `agent+review`
Owners of a Shared calendar MUST be able to publish a read-only `.ics` feed at an unguessable capability URL (≥ 128-bit token, stored hashed), and to rotate and revoke it (ADR 0001 § Published feeds).
- Accept: the feed validates as RFC 5545; rotation invalidates the old URL immediately; a Private calendar cannot have a `full` feed (INV-08).

### E06-R07 · Busy-only feeds from Private calendars   `agent`
**Deferred** until ADR 0001 open question 4 is answered. When it ships, the feed contains `VFREEBUSY`-style opaque blocks derived from the skeleton only.
- Status: Blocked (decision).

### E06-R08 · Android onboarding page   `agent`
The web app MUST serve an "Add to Android" page with DAVx⁵ steps, a deep link into DAVx⁵ with the server URL pre-filled, and a fresh device credential.
- Notes: check which login URI schemes the current DAVx⁵ release supports before implementing. Don't assume a scheme.
- Accept: the deep link opens DAVx⁵ with the server pre-filled (verified by `human` in E15-R05).
