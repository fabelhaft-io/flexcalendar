# `spec/crypto-vectors/gen/` — the independent reference implementation

**Owning requirement:** [E12-R01](../../../docs/epics/E12-crypto-core.md) ·
**Spec:** [`spec/crypto.md`](../../crypto.md) · **Vectors:** [`spec/crypto-vectors/`](../README.md)

This directory generates every vector in `spec/crypto-vectors/`. It is deliberately **not** one of
the libraries: it is Python 3 with PyNaCl, written from `spec/crypto.md` alone, and it neither
imports nor shells out to `packages/crypto_dart` or `packages/crypto-ts` (which it predates). That
is the point of the exercise — the two libraries are tested against a foreign implementation of the
same document instead of against themselves. Keep it that way: a change here may never be derived
from the libraries' code, and the libraries may never be regenerated from this one.

## One command

```sh
spec/crypto-vectors/gen/generate.sh            # regenerate every vector in place
spec/crypto-vectors/gen/generate.sh --check    # regenerate into a scratch directory, then diff
```

`generate.sh` needs only `uv`. It creates a virtual environment **outside the worktree** at
`$CALFLEX_VECTOR_VENV` (default `~/.cache/flexcalendar-agent-team/e12-crypto-vectors-venv`), which
is deliberate: an SDK unpacked under a writable path would end up in git. It installs
`requirements.txt` with `--require-hashes`, so all four artefacts are pinned by version *and*
SHA-256, then runs `generate.py` with the arguments it was given.

`--check` **exits non-zero** if any committed vector file differs from a fresh generation, and also
if a `*.json` file is committed that the generator no longer produces. Run it after any edit to
`spec/crypto.md` or to this directory.

## Pinned environment

| Artefact | Version | Why |
|---|---|---|
| PyNaCl | 1.6.2 | `crypto_aead_xchacha20poly1305_ietf_*`, `crypto_box_*`, `crypto_sign_*` — the same libsodium 1.0.22 the Dart and TS libraries link. |
| cffi | 2.1.1 | PyNaCl's binding layer (transitive). |
| pycparser | 3.11 | cffi's parser (transitive). |
| rfc8785 | 0.1.4 | A **second** JCS implementation, used only to cross-check `gen/jcs.py`. Not part of the vector output. |

Python: 3.11 or newer (developed on CPython 3.14.7). The generator needs no network once the
environment exists; everything it reads (the word list, the DST cases) is in the repository.

## What the generator checks about itself

Before it writes anything, `generate.py` asserts:

1. **HKDF-SHA-256** reproduces RFC 5869 A.1 and A.3 byte for byte — the same two vectors the
   E12-R02 probe asserts (`docs/verification/crypto-libs-2026-10-12.md`).
2. **BIP-0039** reproduces the reference implementation's own vectors (`0000…00` → twelve words,
   and `8080…80`), and `english.txt` hashes to
   `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`. A different word list is a
   hard failure, not a warning.
3. **The DST answers** match `spec/ical-fixtures/dst/cases.json`: the spring gap and the autumn
   overlap (`berlin-2026-spring-skipped`, `berlin-2026-fall-repeated`) and the `daily-skipped`
   expansion the owner ruled on 2026-10-12. The pinned zone database is whatever the host's
   `tzdata` says, which is why the *vectors* pin the RFC 5545 answers and not a tz version.
4. **The fixed-ephemeral sealed box** opens with libsodium's own `crypto_box_seal_open`, and is the
   same length as a freshly sealed one — so a vector that pins a sealed box is still a box a
   library can open. Its layout is checked against libsodium's own `crypto_box_detached` (reached
   with `ctypes`): **tag first**, ciphertext after, and the seal nonce is BLAKE2b at a **24-byte**
   output length, not a BLAKE2b-256 digest.
5. **The hand-written JCS serialiser** agrees with `rfc8785` 0.1.4 on every JSON object a vector
   carries (29 of them at the time of writing).
6. **`VECTOR_INDEX`** claims every generated vector id exactly once, and every id it claims exists:
   the completeness check the review asked for (a field with no vector fails the run).
7. **`same_as` / `differs_from`** claims hold: a vector that says its output equals (or differs
   from) another's is compared at generation time, not by a reader.
8. **Every vector is re-run through the reference operation it is about.** Each opener —
   `open_envelope` (through `do_open`), `open_wrapped_key`, `open_cck_record`, `open_link_bundle`,
   `parse_recovery_phrase`, `parse_link_uri`, `parse_verify_uri`, `parse_key_bundle`,
   `check_key_bundle_matches`, and the short-code comparison — and both sealer wrappers are run
   against the vectors whose `op` names them: a positive must return the value the vector pins and
   a negative must raise the code it pins (66 opener vectors and 11 sealer vectors at the time of
   writing). Review 3 asked for this because neither `crypto_box_seal_open` call site had ever been
   reached by a vector, so both could be handed the wrong arguments without a failure.

## Determinism

Every key, seed, nonce and event is a fixed invented value in `generate.py`. Two things are random
by construction in the real system, and both are handled explicitly rather than papered over:

- **The AEAD nonce.** Every envelope and wrap vector names the nonce as an input. Production code
  draws it from the CSPRNG; the spec's test seam takes it as an argument (§1.2).
- **Sealed boxes.** `crypto_box_seal` draws a fresh ephemeral key, so a *sealing* vector could never
  be stable. The vectors pin a box built with a fixed ephemeral key —
  `epk ‖ crypto_box_easy(m, nonce, recipient_pk, esk)` with
  `nonce = BLAKE2b(epk ‖ recipient_pk, outlen = 24)`, i.e. libsodium's `crypto_generichash` at
  `outlen = crypto_box_NONCEBYTES` (a **24-byte** BLAKE2b output, *not* BLAKE2b-256), byte-for-byte
  what libsodium computes — and depend on a library's `crypto_box_seal_open` to open it; the
  `cck-record-seal-basic` vector also carries the derived nonce and its ephemeral key so the
  derivation can be checked without libsodium. Two consecutive `--check` runs over the committed
  vectors exit 0.

## Files

| File | What it is |
|---|---|
| `generate.py` | The reference implementation and the vector builder. Reads the word list and the DST cases from the repository. |
| `jcs.py` | The hand-written RFC 8785 serialiser, with the `rfc8785` cross-check. |
| `requirements.txt` | The four pinned artefacts with their SHA-256 hashes. |
| `generate.sh` | The one command above. |
| `english.txt` | BIP-0039's `english.txt`, verbatim, from `https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt` (SHA-256 pinned in `generate.py`, 2048 words, LF terminated). |

## Where the inputs come from

- **BIP-0039** word list and algorithm: `bitcoin/bips`, `bip-0039.mediawiki` and `bip-0039/english.txt`.
- **The two official phrase vectors:** `trezor/python-mnemonic`'s `vectors.json`, quoted in
  `generate.py` so a regeneration needs no network.
- **RFC 5869** A.1/A.3, **RFC 8785** §3.2, **RFC 5545** §3.3.5/§3.3.10 and **RFC 7986** §3.1 are
  cited where they are used.
- **The DST answers** come from `spec/ical-fixtures/dst/cases.json`, the authoritative table
  (E15-R02); the generator fails if its own answer disagrees with a case it cites.
