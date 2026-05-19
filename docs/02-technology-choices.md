# Technology Choices

For each layer, a recommended pick and the realistic alternatives.

## CalDAV Server

**Pick: [Radicale](https://radicale.org/) for prototyping, [Baïkal](https://sabre.io/baikal/) or [SabreDAV](https://sabre.io/) for production.**

| Option       | Lang   | Pros                                                                 | Cons                                                       |
|--------------|--------|----------------------------------------------------------------------|------------------------------------------------------------|
| Radicale     | Python | Tiny, file-backed, trivial to run, great for prototyping.            | Limited sharing/ACL story; not built for large scale.      |
| Baïkal       | PHP    | Production-ready, mature, web admin UI, uses SabreDAV under hood.    | PHP hosting; less hackable.                                |
| SabreDAV     | PHP    | Library you embed; powers Nextcloud, Baïkal, Fruux.                  | You build the app around it.                               |
| Xandikos     | Python | Git-backed storage (events versioned as files in a git repo).        | Smaller community; fewer production deployments.           |
| Nextcloud    | PHP    | Full groupware; calendar is one app; battle-tested sharing.          | Heavyweight if calendar is all you need.                   |

For a brand-new product, **start with Radicale** locally to validate the native-app integration story end-to-end in a weekend. Migrate to **SabreDAV** (as a library inside your own service) once you need custom auth, sharing, and push.

## Backend API Layer

**Pick: Node.js (TypeScript) with Fastify or NestJS, or Go with chi/echo.**

Either is fine; pick the language you ship faster in. The API is thin — auth, push fan-out, sharing UI, a REST/GraphQL facade over CalDAV. Notes:

- For CalDAV client work from the backend, use [`tsdav`](https://github.com/natelindev/tsdav) (TypeScript) or `go-caldav` / hand-rolled with `net/http` + an iCalendar parser like [`gocal`](https://github.com/apognu/gocal).
- iCalendar parsing/generation: [`ical.js`](https://github.com/kewisch/ical.js) (Mozilla; the de facto standard) on the Node side.
- Push: APNs via `node-apn` or Apple's HTTP/2 API directly; FCM via the Firebase Admin SDK.
- Auth: Auth0, Clerk, or self-hosted Keycloak/Ory. The API translates user auth → CalDAV credentials (store CalDAV credentials encrypted, or run a CalDAV server that accepts your bearer tokens).

## Web Client

**Pick: React + TypeScript + Vite, with [FullCalendar](https://fullcalendar.io/) for the calendar grid.**

FullCalendar is the most mature, accessible JS calendar component and handles recurrence, drag-to-resize, multi-day events, timezones. Alternatives: Schedule-X (newer, lighter), react-big-calendar (simpler, less polished).

State/data: TanStack Query for server state, Zustand or Redux Toolkit only if you actually need shared client state beyond what Query gives you.

## iOS Client

**Pick: Swift + SwiftUI, targeting iOS 16+.**

- Native calendar view: there isn't a great built-in one. Either embed a web view with FullCalendar, build your own with SwiftUI (very feasible for month/week/day grids), or use [HorizonCalendar](https://github.com/airbnb/HorizonCalendar) (Airbnb, MIT).
- Networking: URLSession + async/await is plenty.
- Offline cache: SwiftData (iOS 17+) or Core Data, with iCalendar objects as the canonical form.
- To add the CalDAV account to the system Calendar app for users who want that: ship a [.mobileconfig configuration profile](https://developer.apple.com/business/documentation/Configuration-Profile-Reference.pdf) or instruct the user to add the account manually in Settings → Calendar → Accounts.

## Android Client

**Pick: Kotlin + Jetpack Compose, minSdk 26 (Android 8).**

- Calendar UI: [Compose Calendar](https://github.com/kizitonwose/Calendar) by kizitonwose is excellent for the date grid.
- Networking: Ktor client or Retrofit + OkHttp.
- Offline cache: Room.
- **Sync adapter**: implement a [SyncAdapter](https://developer.android.com/training/sync-adapters) that writes into Android's `CalendarContract`. Once your events are in CalendarContract, both Google Calendar and Samsung Calendar will display and edit them — this is exactly how DAVx⁵ works. See `03-native-calendar-integration.md` for details.

## Cross-Platform Alternative

If you don't want to maintain three codebases, **Flutter** with a CalDAV package (e.g. `dart_webdav` + a hand-rolled iCalendar layer) gets you iOS + Android + Web from one codebase. The Android sync-adapter integration is harder from Flutter (you'd drop to Kotlin for that bit anyway). React Native is a similar trade-off. Decision rule: if native-quality calendar UX matters, stay native; if shipping speed matters more, Flutter is the strongest single-codebase choice.

## Hosting

- CalDAV server + API: a single small VPS (Hetzner, Fly.io, Railway) for the prototype. Behind a managed Postgres if you choose SabreDAV with its DB backend.
- TLS: Caddy or Traefik, automatic Let's Encrypt. iOS in particular is fussy about TLS — no self-signed certs without a profile.
- The CalDAV server **must be reachable on the public internet on port 443** for stock apps to talk to it. This is a real constraint: no internal-only deployments unless you also ship a VPN profile.
