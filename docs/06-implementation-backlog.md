# Implementation Backlog — Epics and Requirements

This is the implementation backlog: the plan in `00`–`05` and ADRs 0001–0003 broken into epics and requirements that coding agents can pick up and finish without asking for more context. The epics are in [`epics/`](epics/), one file each. This file holds what applies to all of them: the decisions that must be pinned first, the invariants no change may break, the rules agents follow, and the dependency graph.

The numbered docs and ADRs are still the spec. If this backlog disagrees with them, the docs win, and the disagreement is a bug in the backlog to fix.

## How to read a requirement

```
### E05-R03 · Event CRUD with ETag preconditions   `agent`
The API MUST ...                       <- normative statement (RFC 2119 words)
- Accept: ...                          <- checkable acceptance criteria
- Deps: E04-R02, D-04                  <- must be Done first
- Notes: ...                           <- optional context, links to the spec
```

**Executor tags**

| Tag | Meaning |
|---|---|
| `agent` | An agent can finish it alone. CI must prove the acceptance criteria. |
| `agent+review` | An agent implements it and a human approves the PR before merge. Used for auth, crypto, escrow, ACLs and anything that touches the privacy claim. |
| `human` | Needs physical devices, accounts, money, signing identities, DNS or legal judgement. An agent may prepare material (scripts, checklists, drafts) but cannot mark it Done. |

**Status** is tracked per epic in its header table: `Blocked` (on a decision or dependency), `Ready`, `In progress`, `Done`.

## Agent working agreement

1. **Pick up only `Ready` work.** A requirement is Ready when every `Deps` entry is Done and every decision it cites under `D-*` is `Pinned`. When something you need is not Pinned, stop and escalate. Don't guess: CLAUDE.md says the open questions change the architecture.
2. **One requirement per PR** where practical. Branch `feat/E05-R03-event-crud`, and name the requirement ID in the PR title.
3. **Every acceptance criterion needs a test** or a recorded manual check. `human` checks go into `docs/verification/` as dated notes with screenshots.
4. **`make verify` must pass** (defined in E02-R04). It runs lint, type checks, unit tests, the invariant checks and the iCalendar round-trip corpus.
5. **Invariants (below) are hard gates.** A PR that breaks one is rejected, whatever it passes.
6. **Update the docs in the same PR** when behaviour or a technology choice moves away from `00`–`05` or an ADR. A new decision gets a new ADR, using `adr/0000-template.md`.
7. **Security-sensitive work is `agent+review`.** Never merge it yourself.
8. **Never commit secrets**: signing certs, APNs keys, HSM credentials, SMTP credentials, Firebase service accounts. Everything is read from the environment, and `.env.example` documents the variable names.

## Decisions to pin before agents start (D-*)

The docs left these open, or disagreed with themselves, in ways that would make agents build different incompatible things. **All were pinned on 2026-10-04**, as the Recommendation column states. Three version or vendor details were updated at pinning time: Node 24 instead of 22 (D-01), PHP 8.4 instead of 8.3 (D-02), and AWS KMS as the KMS vendor (D-10). The ADR amendments the decisions call for are in ADR 0001 § Amendments and ADR 0002. Changing a pinned decision needs a human and, where it touches an ADR, a new ADR or amendment.

| ID | Decision | Recommendation | Why it blocks | Blocks | Status |
|---|---|---|---|---|---|
| D-01 | Backend runtime | **Node 24 LTS + TypeScript, Fastify; move to Node 26 once it is promoted to LTS (late October 2026).** Node 22 reaches end of life in April 2027, too soon for a new codebase. Go is ruled out already: ADR 0002 makes `ical.js` the single recurrence authority applied *by the API*, and Go can't run it. | Every server epic | E05–E07 | **Pinned** 2026-10-04 |
| D-02 | CalDAV server from Phase 1 on | **SabreDAV 4.7+ in a small PHP 8.4 service, Postgres PDO backend.** SabreDAV 4.7 supports PHP up to 8.4; PHP 8.3 is already security-only. Radicale only for Phase 0. Phase 1 needs a custom auth backend (D-05), the mode-aware write guard and the change outbox. Phase 4 adds Apple sharing extensions and iMIP. Radicale is partial or missing on all of these, and switching later would mean a storage migration with real family data in it. This also removes the old item "move CalDAV storage from filesystem to Postgres". | Server schema, auth, sharing | E03, E04, E06 | **Pinned** 2026-10-04 |
| D-03 | Identity provider | **Self-hosted Keycloak** (OIDC + PKCE, TOTP and WebAuthn second factors, no per-user cost). For a privacy product, sending the user directory to a third-party IdP is itself a disclosure. Auth0/Clerk are faster to start with if that trade is acceptable. | Auth, Tier 1 second factor | E05, E14 | **Pinned** 2026-10-04 |
| D-04 | **How stock apps authenticate** (missing from the docs) | **Per-device app passwords.** Apple Calendar and DAVx⁵ speak HTTP Basic, not OIDC, so an OIDC login cannot reach them. Generate a random password of ≥ 128 bits per device and store it as an Argon2id hash. SabreDAV checks it; it is shown once, embedded in the `.mobileconfig`, and revocable per device. | Onboarding, SabreDAV auth | E03, E06 | **Pinned** 2026-10-04 |
| D-05 | How the API authenticates to CalDAV | **Service principal with delegated identity** on an internal-only listener: an HMAC-signed `X-Calflex-Principal` header that SabreDAV accepts only from the API's network. The API never stores user CalDAV passwords. | API ↔ CalDAV | E03, E05 | **Pinned** 2026-10-04 |
| D-06 | **Private-mode change detection** (conflicts with the sync model) | Editing only the *content* of a Private event writes the sidecar and leaves the `VEVENT` unchanged. Its ETag and the collection sync-token then don't move, and other clients never see the edit. **Every envelope write also rewrites the skeleton with `X-CALFLEX-ENVELOPE-SHA256:<hash>`.** The sidecar row carries the same hash. The write order is envelope row, then skeleton `PUT` with `If-Match`, and the superseded row is garbage-collected after the commit. Readers accept only an envelope whose hash matches the skeleton. **Needs an ADR 0001 amendment**: the sidecar key gains a hash/version column. | Sidecar schema, sync | E04, E13 | **Pinned** 2026-10-04 |
| D-07 | **Recurring edits on Private calendars** (ADR 0001 vs ADR 0002) | ADR 0001 binds `DTSTART`/`DTEND`/`RRULE` into the AAD. ADR 0002 has the API rewrite those fields when it applies "this and following" (for example, `UNTIL` on the master), and that silently invalidates the master's envelope. **Two-step intent for Private calendars:** the API computes the resulting skeletons with `ical.js` and returns a plan, the client re-seals an envelope for every skeleton the plan changes, and it commits plan and envelopes together with `If-Match`. Shared calendars keep the one-step intent. **Needs an ADR 0001 amendment.** | Recurrence API, crypto | E05, E13 | **Pinned** 2026-10-04 |
| D-08 | ADR 0001 open questions 1–2 | Adopt the ADR's own recommendations: **cleartext skeleton, yes; `ATTENDEE`/`ORGANIZER` encrypted, no invites on Private.** Add one rule the ADR misses: `VALARM` is cleartext, so our clients MUST write a fixed `DESCRIPTION:Reminder` and never the event title. | Crypto payload shape | E12, E13 | **Pinned** 2026-10-04 |
| D-09 | Repository layout and toolchain | Monorepo (see E02-R01): pnpm workspaces for TS, a Flutter app with local Dart packages, a PHP service with Composer, one root `Makefile`. | Everything agents touch | E02 | **Pinned** 2026-10-04 |
| D-10 | Hosting and HSM provider | VPS for the app (Hetzner, EU) plus an **HSM-backed KMS key** for Tier 1 escrow: **AWS KMS in `eu-central-1`**, whose keys are always held in HSMs. GCP Cloud KMS at the HSM protection level would do equally well; the vendor can still be swapped before Phase 7 starts at no cost. A dedicated CloudHSM cluster costs far more than this product needs. *Re-checked 2026-10-04:* Hetzner's June 2026 cloud repricing raises the budget to about €70/month until M1, but it doesn't change the choice (`02` § Sizing and cost). | Deploy, Phase 7 escrow | E08, E14 | **Pinned** 2026-10-04 |
| D-11 | Backups start in Phase 1 | CLAUDE.md says "bake this in from Phase 1"; the old `04` listed backups under Phase 6. **Phase 1 wins.** `04` now reflects this. Tooling: pgBackRest into two repositories at two providers (`02` § Backups and recovery, E08-R04). | Ops | E08 | **Pinned** 2026-10-04 |
| D-12 | Realistic sync-latency exit criteria | The old Phases 1 and 2 promised that edits show up "within seconds" in stock apps. Stock apps poll on their own schedule (iOS Fetch, DAVx⁵ sync interval ≥ 15 min), so we can't guarantee that. **Restate:** seconds for our own clients; for stock apps, on the next refresh or on opening the app. `04` now uses this wording. | Milestone acceptance | M2, M3 | **Pinned** 2026-10-04 |
| D-13 | Self-hosted vs SaaS | Already answered: ADR 0001 lists "we host the instance" as a **hard** requirement. Open question 1 is marked answered in `05` and CLAUDE.md. Pricing and quotas stay open and block nothing here. | Auth model | — | **Pinned** 2026-10-04 |
| D-14 | AAD coverage | ADR 0001's AAD binds `UID`, epoch and timing, but not `RECURRENCE-ID` or the calendar ID. The server could then move an override's envelope onto another override of the same event, or across calendars. **Add `calendar_id` and `recurrence_id` to the AAD.** Needs an ADR 0001 amendment; cheap now, and a format break once M1 puts real family data under it. | Wire format | E12 | **Pinned** 2026-10-04 |
| D-15 | **Public-key authenticity** (missing from ADR 0001) | Sealed boxes don't authenticate the sender, and members' public keys are handed out by our server. A malicious server could substitute its own key when a member is added, receive the CCK and read everything. That breaks the Tier 2 "we cannot read it" claim. **Sign CCK records and key bundles with a per-user Ed25519 identity key, and let members compare safety numbers (or a QR code) in the app.** Key transparency can come later. Needs an ADR 0001 amendment. | Sharing Private calendars, trusted contacts | E12, E13, E14 | **Pinned** 2026-10-04 |
| D-16 | Crypto on web (ADR 0002 tension) | ADR 0002 says the key hierarchy "lives in Dart only", but the web client has to unwrap keys (via device linking or the recovery code, per D-17), open envelopes and seal CCKs to share. **Web implements that operational subset in TS. Recovery-code generation, Shamir and escrow setup stay Dart-only (mobile) in v1.** Recorded in ADR 0002. | Web Private mode | E12, E13 | **Pinned** 2026-10-04 |
| D-17 | **Keys must not derive from the login password** (missing from ADR 0001) | ADR 0001 wraps the private key under an Argon2id KEK from "the user password", but that password is typed into our IdP (D-03), which we host. We could derive the KEK, so the Tier 2 claim "we cannot read it" would be false. **Generate keys on the device and keep them in Keystore/Keychain-backed storage. Move them to new devices only by device linking (QR code and short code, keys sealed to the new device's ephemeral X25519 key). The only server-side wrapped copy is under the recovery-code KEK (HKDF). Remove KEK_pw from ADR 0001's key diagram.** Argon2id returns only if a separate passphrase option is added later. OPAQUE is the alternative that keeps password-only login, if both an IdP authenticator and a Dart client exist. Needs an ADR 0001 amendment; see ADR 0003 decision 5. | Key hierarchy, recovery | E04, E12, E14 | **Pinned** 2026-10-04 |

**When each decision is first needed** (phase order from ADR 0003). All are pinned now; the table says which phase first builds on each one:

| Before | Decisions |
|---|---|
| Phase 1 (server core) | D-01, D-02, D-03, D-05, D-06, D-09, D-10 (VPS part), D-11, D-13 |
| Phase 2 (crypto core) | D-08, D-14, D-15, D-17 |
| Phase 3 (Android app) | D-07 |
| Phase 4 (stock apps) | D-04, D-12 |
| Phase 5 (web, iOS) | D-16 |
| Phase 7 (escrow) | D-10 (KMS part) |

## Global invariants (INV-*)

Every PR in every epic must preserve these. Where a check can be automated, E02-R05 turns it into a CI check.

| ID | Invariant | Automated check |
|---|---|---|
| INV-01 | **CalDAV is the source of truth.** The API keeps no event fields that diverge from the `VEVENT`. App-only data goes in `X-` properties, or in Postgres tables that hold no event content. | Schema review; no event-content columns outside the sidecar |
| INV-02 | **Lossless round-trip.** Any property, parameter or component we don't understand survives a read-modify-write untouched, `X-` properties included. | Round-trip corpus (E15-R01) |
| INV-03 | **`UID`s our code creates are random UUIDv4**, never derived from content. We don't rewrite stock-app `UID`s. | Unit test on every create path |
| INV-04 | **Time**: `DTSTART`/`DTEND` carry an IANA `TZID` or `Z`. All-day events are `VALUE=DATE`, and never midnight-to-midnight date-times. Dart code never does zoned maths with `DateTime`; it uses `TZDateTime`. | Lint rule plus DST matrix (E15-R02) |
| INV-05 | **Recurrence has one authority per runtime**: `ical.js` in the API, `iCal4j` in the Android adapter. Clients send intents and never write `EXDATE`/`RECURRENCE-ID` themselves. Client-side `rrule` is only for previews and offline display. | Code search in CI: client packages must not emit those properties |
| INV-06 | **Push payloads are data-only change pings**: calendar ID and a hint, never titles, times or attendees. | Payload schema test |
| INV-07 | **The server never decrypts.** The API and CalDAV service link no content-crypto library, and no server log contains envelope plaintext. | Dependency allow-list check |
| INV-08 | **Private calendars are invisible to stock-app paths.** Device app-password credentials, the Android sync adapter and full-detail `.ics` feeds cannot discover or read a Private collection. | Integration test (E03-R07) |
| INV-09 | **No security questions** anywhere in auth or recovery. | Review |
| INV-10 | **Mode changes are never silent**: every change is logged, members are notified, and the owner confirms it. | Integration test (E13-R06) |
| INV-11 | **Honest copy**: product text about privacy matches the claim table in ADR 0001. Tier 1 is never described as unreadable by us. | `agent+review` on copy PRs |
| INV-12 | **The login password never feeds a key derivation** (D-17). It authenticates at the IdP and nothing else; keys come from the device, device linking, the recovery code or (Tier 1) escrow. | Review; CI grep that the crypto packages take no password input |

## Epics

Most epics span phases now: each epic's header says which of its requirements belong to which phase. The Phase column lists the phase of the first requirement and, in brackets, the phases of the rest.

| Epic | Title | Phase | Primary executor | Depends on |
|---|---|---|---|---|
| [E01](epics/E01-integration-spike.md) | Phase 0 integration spike | 0 (parallel; gates 4) | human (agent-prepared) | — |
| [E02](epics/E02-repo-tooling-ci.md) | Monorepo, tooling, CI, local stack | 0–1 | agent | D-09 |
| [E03](epics/E03-caldav-service.md) | CalDAV service (SabreDAV) | 1 (4) | agent+review | E02, D-02, D-05; D-04 for Phase 4 |
| [E04](epics/E04-data-model.md) | Relational data model and migrations | 1 | agent | E02, D-02, D-06, D-17 |
| [E05](epics/E05-api-core.md) | API core: auth, events, recurrence | 1 (3, 4) | agent | E03, E04, D-01, D-03; D-07 for R07 |
| [E06](epics/E06-sharing-feeds-onboarding.md) | Sharing, feeds, stock-app onboarding | 3 (4) | agent+review | E05 |
| [E07](epics/E07-change-fanout.md) | Change detection and push fan-out | 4 (5) | agent | E05 |
| [E08](epics/E08-operations.md) | Hosting, TLS, backups, observability, mail | 1→ | human + agent | E02, D-10, D-11 |
| [E09](epics/E09-web-client.md) | Web client | 5 | agent | E05, E06, E07, E12 (TS) |
| [E10](epics/E10-mobile-app.md) | Flutter mobile app | 3 (4, 5) | agent | E05, E12, E13 |
| [E11](epics/E11-android-sync-adapter.md) | Android sync adapter (Kotlin) | 6 | agent + human | E03 (Phase 4 reqs), E10 |
| [E12](epics/E12-crypto-core.md) | Crypto core and shared test vectors | 2 (5, 7) | agent+review | E02, D-08, D-14, D-15, D-17 |
| [E13](epics/E13-private-mode.md) | Private mode end to end | 3 (4, 5) | agent+review | E05, E10, E12, D-06, D-07 |
| [E14](epics/E14-recovery.md) | Account recovery tiers | 3 (7) | agent+review + human | E12, E13; D-10 for Phase 7 |
| [E15](epics/E15-interop-regression.md) | Interop and regression test program | cross-cutting | agent + human | E02 |
| [E16](epics/E16-polish-and-mirroring.md) | Phase 8: polish and optional mirroring | 8 | mixed | E11, E13 |

### Dependency graph

```
 D-* pinned ─┐
             v
 E02 tooling ──┬──> E03 CalDAV core ──┐
               ├──> E04 schema ───────┴──> E05 API core ─────────────┐
               ├──> E08 ops (continuous)                             │
               ├──> E15 interop (continuous)                         v
               └──> E12 crypto core (Dart) ──────────> E10 Android app + E13 Private mode
                                                       + E06-R02/R09 invites + E14 recovery code, linking
                                                                     │
                                                                     v
                                                         M1: family v1 (Android, Private)
                                                                     │
 E01 spike (parallel) ──> M0 ────────────────────────────────────────┤
                                                                     v
                                         E03/E06 stock-app surface, E07 push, E13 mode switching
                                                                     │
                                                                     v
                                                         M2: Shared mode + stock apps
                                                                     │
                                  ┌──────────────────────────────────┼─────────────────────────┐
                                  v                                  v                         v
                     E09 web + E12 TS + E10 iOS          E11 Android adapter     E14 escrow + trusted contacts
                              (M3)                               (M4)               (M5: open signup)
                                  └──────────────────────────────────┴─────────────────────────┘
                                                                     │
                                                                     v
                                                                E16 polish
```

E12 has no product dependencies, so it runs in parallel with the server epics. It is on the critical path to M1 now, not a side track.

## Milestones

| Milestone | Phase | Needs | Exit check (the D-12 wording applies) |
|---|---|---|---|
| M0 | 0 | E01 | The same event visible and edited in Apple Calendar, in Samsung or Google Calendar via DAVx⁵, and in the server store. Quirks log committed. **Must be reached before Phase 4 starts.** |
| M1 | 3 | E02; E03 Phase 1 reqs; E04; E05 Phase 1 reqs + R07; E06-R02, R09; E08-R01..R05, R07; E10 Phase 3 reqs; E12 Phase 2 reqs; E13-R01..R05, R07, R08, R09 (v1 copy); E14-R03, R06, R08, R09 | **Family v1.** Two family members on Android phones share a Private calendar and see each other's edits after refreshing, or within 15 min in the background. The E13-R08 blind check on staging finds nothing. A user who wipes their phone gets back in with the recovery code. A second device links by QR. Restore-from-backup drill passed. |
| M2 | 4 | M0; E03 Phase 4 reqs; E05-R06; E06-R01, R03..R06, R08; E07-R01, R03..R05; E08-R06; E10-R07 (push), R09; E13-R06 | One Shared calendar visible and editable in Apple Calendar (via `.mobileconfig`), in Samsung or Google Calendar via DAVx⁵, and in our Android app. Our app receives a ping within seconds of a stock-app edit; stock apps show our changes on their next sync. A Shared → Private switch leaves no plaintext `SUMMARY` and writes the audit entry. |
| M3 | 5 | E07-R02; E09; E10 Phase 5 reqs; E12 TS library; E13 web parts | A user runs their calendar entirely from the web app. Web-to-web updates arrive in ≤ 5 s. The iOS app and the web read and write the same Private calendar as Android. |
| M4 | 6 | E11 | A Pixel and a Samsung phone show a Shared calendar in the stock app without DAVx⁵, with two-way edits. |
| M5 | 7 | E14 (all), E13-R09, external crypto review | The `04` Phase 7 exit criteria, verbatim. **Open signup stays closed until M5.** |
