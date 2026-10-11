# Review checklist

The implementer's self-reported "pass" is not evidence. Neither is a static checker for a runtime criterion: `make check-stack` passed on E02-R03 while the seed failed on any non-default port.

## Execute every acceptance criterion

- Run each criterion and paste the command and the observed output into the review doc. A runtime criterion is never passed "by inspection".
- New scripts, Make targets and CLIs must complete a real **happy-path** run, not only their error path.
- Run what the sandbox couldn't: `make dev`, `make seed`, integration tests, and `make verify` (E02-R04). Use the stack recipes in [`environment.md`](environment.md).

## Your own checks and negative controls

- Where the implementer's check could be vacuous, write your own: inject the defect each gate exists for and confirm it fails for **that** reason. A Prettier failure doesn't prove the type checker works, so make the injected code otherwise clean. Restore the files afterwards.
- Other negative controls: run on `main`, with an older tool version, a bogus token, or a non-default port (a second stack on 9443).
- **Tests** must fail on a real bug. A mock that freezes state the code under test mutates is not coverage. Mutation-test a new test: remove each detection it claims to cover and check that the matching case fails (E02-R07's `gen-check` tests, part by part).
- **Check your own review helpers for vacuous results.** A snapshot of an empty directory looked "identical" once. Make each helper fail on a known difference, and print what it compared (names, counts).

## CI changes and gates

- Review a CI change on real GitHub runs. Push the branch and open a **draft PR** for it. For each behaviour the Accept lines promise, add a **throwaway test PR** against the requirement branch (a web-only change, a deliberately failing gate, a spec edit without regeneration), titled "… (review only, do not merge)". Close them afterwards; never merge them; never force-push. Their branches stay for the owner to remove.
- Design each throwaway change to isolate the gate: change something the other checks don't read (E02-R07's `info.version` made only the Dart client stale), so the PR fails for the gate's reason. Read the failing job's log for that reason (`gh run view <run> --log-failed --job <id>`), not only its colour.
- Test the near-miss that should still pass or fail too: a README-only change next to a generated directory (component path), a change to a generator's input (E02-R07's `swagger_parser.yaml` went green until the inputs selected the full run).
- A gate over an empty input can't fail. Check that each generator, validator and comparison gets real input (E02-R07's contract started as `paths: {}`) and that a deliberately broken input fails it.
- **Generated output:** generators add files, they don't remove them. Regenerate from an empty output directory, and add an **orphan control**: a committed file that the generator no longer produces must fail the staleness check (E02-R07: it passed until `make gen` wiped `lib/api` first).
- The CI runner's Podman is 4.9.3, older than a dev host's. Exec-form health-check arguments must be whitespace-free; `make check-stack` enforces it.

## Versions upstream

- Every pinned or chosen version must exist and fit the rest of the toolchain: npm (`npm view`), Packagist (`repo.packagist.org/p2/<pkg>.json`, minified, so later entries inherit keys), Docker Hub, Gradle/Flutter (`gradle_utils.dart` at the Flutter tag gave E02-R02's limits).
- Check that the version **installs**: Composer refuses releases that have security advisories (E02-R04's PHPUnit 12.4.2).
- Check binaries such as wrapper jars against their published checksums.
- A fresh pin should be a current release, not an old one from the model's training data.

## Scope

- The diff touches only what the requirement needs, and every file is inside `--paths`.
- Unrequested edits to existing code are findings, even when small. E02-R04 dropped an error message from the API's startup log.
- Follow-ups go in the findings doc and in the new file `docs/reviews/follow-ups/from-<ID>.md`, not in the code and not into an existing line of `follow-ups.md`.

## Facts

Check every factual claim in the diff, READMEs and comments included, against the docs and against the running system. Every requirement so far shipped at least one wrong claim:

- a licence and a phase number (R01);
- a product name, "FlexCalendar", that appears nowhere in the docs (R02);
- "one requirement per epic" and misattributed INV citations (R08);
- "owner-only" files that were really mode 0644 (R03);
- a comment about discovering packages above a hard-coded list (R04).

ADRs 0001–0002 still use the old phase numbers; `docs/04` has the mapping.

## Invariants (`06`)

- INV-01: no event-content columns outside the sidecar.
- INV-03: UUIDv4 on every create path.
- INV-04: `TZID` or `Z` on times; all-day events are `VALUE=DATE`.
- INV-05: clients never emit `EXDATE` or `RECURRENCE-ID`.
- INV-07: no content-crypto libraries in `server/**`.
- INV-12: no key derivation from the login password.
- No event content in logs, error messages or commit messages.

## The spec wins over the code

- Check the requirement against the doc its Spec row cites.
- A gap in the docs is fixed in the same PR, or needs a new ADR with the owner's sign-off.
- A requirement the owner wants changed gets its own `doc(<ID>): …` PR first.

## Secrets and configuration

- No secrets committed.
- Every new variable is documented in the relevant `.env.example` (`infra/dev/.env.example` for the stack).

## iOS

No iOS checks before Phase 5, even where an earlier requirement mentions iOS. Scope those criteria to Android and the Dart VM.
