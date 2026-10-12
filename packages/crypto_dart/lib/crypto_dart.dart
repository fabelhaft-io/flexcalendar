/// The flexcalendar Dart crypto core (E12), Phase 2.
///
/// This library implements the envelope formats of `spec/crypto.md` for
/// `packages/crypto_dart`: the event envelope and the calendar-metadata envelope
/// (D-18), their canonical AADs (§2), the canonical timing fields they bind (§3),
/// the JSCalendar payload they carry (§4) and the `X-CALFLEX-ENVELOPE-SHA256` read
/// gate (§5.1). It is one of the two implementations that must produce
/// byte-identical output from the frozen vectors in `spec/crypto-vectors/`; the
/// other is `packages/crypto-ts` (Phase 5).
///
/// The key hierarchy itself — keypairs, the recovery code, HKDF, sealed CCK
/// records and device linking — is E12-R04; here the calendar content key is an
/// input.
///
/// **Never a password.** No function in this package takes one (D-17, INV-12).
/// The login password authenticates at the IdP and is an input to nothing here.
///
/// **Never a server.** Nothing under `server/**` links this package (INV-07), and
/// no refusal message carries a payload byte.
library;

export 'src/aad.dart';
export 'src/envelope.dart'
    show
        freshNonce,
        openCalendarMetadata,
        openEvent,
        sealCalendarMetadata,
        sealEvent;
export 'src/errors.dart';
export 'src/jcs.dart';
export 'src/payload.dart' hide validatePayloadStructure;
export 'src/skeleton_hash.dart';
export 'src/timing.dart';
