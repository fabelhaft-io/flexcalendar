/// The flexcalendar Dart crypto core (E12), Phase 2.
///
/// This library implements the formats of `spec/crypto.md` for
/// `packages/crypto_dart`:
///
/// - the event envelope and the calendar-metadata envelope (D-18), their canonical
///   AADs (§2), the canonical timing fields they bind (§3), the JSCalendar payload
///   they carry (§4) and the `X-CALFLEX-ENVELOPE-SHA256` read gate (§5.1) —
///   E12-R03;
/// - the key hierarchy (§6) — E12-R04: user keypairs (X25519 sealing, Ed25519
///   signing per D-15), the key bundle, the recovery code and its HKDF KEK (§6.3.1,
///   D-17), the wrap and unwrap of the private keys, device linking (§6.7), CCK
///   generation and the sealed, signed CCK record (§6.6), and the identity
///   fingerprints, safety numbers and verification payload of §6.8.
///
/// It is one of the two implementations that must produce byte-identical output
/// from the frozen vectors in `spec/crypto-vectors/`; the other is
/// `packages/crypto-ts` (Phase 5, D-16). Per D-16 the Dart library owns the
/// recovery code and every wrap; the TS library implements only the operational
/// subset.
///
/// **Never a password.** No function in this package takes one (D-17, INV-12). The
/// login password authenticates at the IdP and is an input to nothing here: keys
/// are generated on the device, and they reach a new device by device linking, the
/// recovery code or (Tier 1, Phase 7) escrow.
///
/// **Never a server.** Nothing under `server/**` links this package (INV-07), and
/// no refusal message carries a key byte, a wrap byte or a payload byte.
library;

export 'src/aad.dart';
export 'src/cck.dart' hide sealCckRecordWithEphemeralKey;
export 'src/device_link.dart' hide sealLinkBundleWithEphemeralKey;
export 'src/encoding.dart';
export 'src/envelope.dart'
    show
        freshNonce,
        openCalendarMetadata,
        openEvent,
        sealCalendarMetadata,
        sealEvent;
export 'src/errors.dart';
export 'src/identity.dart';
export 'src/jcs.dart';
export 'src/key_bundle.dart';
export 'src/key_material.dart';
export 'src/key_wrap.dart' hide sealWrappedKeyWithNonce;
export 'src/payload.dart' hide validatePayloadStructure;
export 'src/recovery_code.dart';
export 'src/skeleton_hash.dart';
export 'src/timing.dart';
