/**
 * E12-R02 crypto-libs probe — the checks, shared by `probe.mjs` (the standard
 * `libsodium-wrappers` build) and `probe-sumo.mjs` (the sumo build).
 *
 * Every fixed value below is an **invented test value, never a secret**: fixed
 * keys, a fixed nonce, a fixed message and a fixed Ed25519 seed exist so the
 * three probes (Dart VM, Flutter/Android, Node) print byte-identical hex for
 * the same primitive. Sealed boxes and the RNG are randomised; only their
 * round trips are compared.
 *
 * No password-based key derivation is called anywhere (D-17, INV-12): the
 * `crypto_pwhash` family is only *listed* for presence, never invoked, and no
 * key in here derives from a password.
 */

/** Fixed run of bytes: start, start+1, ... — the same values in all probes. */
const run = (start, length) =>
  Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const utf8 = (text) => new Uint8Array(Buffer.from(text, 'utf8'));

export const FIXED = {
  // AEAD inputs.
  aeadKey: run(0x00, 32),
  aeadNonce: run(0x40, 24), // XChaCha20-Poly1305-IETF nonce is 24 bytes.
  message: utf8('flexcalendar E12-R02 probe'),
  aad: utf8('calflex-v1-probe-aad'),
  // Ed25519: a fixed seed makes the key pair and the signature deterministic.
  ed25519Seed: run(0x20, 32),
  // crypto_kdf (BLAKE2b) inputs.
  kdfMasterKey: run(0x60, 32),
  kdfContext: 'calflex1', // 8 bytes, crypto_kdf_CONTEXTBYTES
  kdfSubkeyId: 1,
};

/** RFC 5869 test case 1 — the one HKDF vector every implementation must match. */
export const RFC5869_TC1 = {
  ikm: new Uint8Array(22).fill(0x0b),
  salt: run(0x00, 13),
  info: run(0xf0, 10),
  okmLength: 42,
  // Published in RFC 5869 appendix A.1.
  prk: '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5',
  okm: '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
};

/**
 * RFC 5869 test case 3 — empty salt and empty info, so it is also reachable
 * through the Dart API, whose `KdfHkdf.expand` takes the info as a String.
 */
export const RFC5869_TC3 = {
  ikm: new Uint8Array(22).fill(0x0b),
  salt: new Uint8Array(0),
  info: new Uint8Array(0),
  okmLength: 42,
  // Published in RFC 5869 appendix A.3.
  prk: '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04',
  okm: '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
};

/** A 10-byte ASCII info, compared with the Dart VM probe's result. */
export const ASCII_HKDF_INFO = 'calflexhk';

/** The primitives E12-R02 asks about, as libsodium-wrappers spells them. */
export const REQUIRED_EXPORTS = {
  'aead.xchacha20poly1305_ietf': [
    'crypto_aead_xchacha20poly1305_ietf_encrypt',
    'crypto_aead_xchacha20poly1305_ietf_decrypt',
  ],
  'box.seal': ['crypto_box_seal', 'crypto_box_seal_open'],
  'sign.ed25519': [
    'crypto_sign_detached',
    'crypto_sign_verify_detached',
    'crypto_sign_seed_keypair',
  ],
  'kdf.derive_from_key': ['crypto_kdf_derive_from_key'],
  'kdf.hkdf_sha256': [
    'crypto_kdf_hkdf_sha256_extract',
    'crypto_kdf_hkdf_sha256_expand',
  ],
  'randombytes.buf': ['randombytes_buf', 'sodium_version_string'],
};

class Report {
  constructor() {
    this.lines = [];
    this.failures = [];
    this.gaps = [];
  }

  /** Records `name=value`, the line format all three probes share. */
  value(name, value) {
    this.lines.push(`${name}=${value}`);
  }

  /** Records a primitive the library does not provide at all. */
  gap(name, why) {
    this.value(name, 'absent');
    this.gaps.push(`${name} (${why})`);
  }

  /** Records a check the library failed — this is a defect, not a gap. */
  fail(name, why) {
    this.failures.push(`${name}: ${why}`);
  }

  ok(name) {
    this.value(`${name}.result`, 'ok');
  }
}

const has = (sodium, name) => typeof sodium[name] === 'function';

/** Runs a check that must throw; reports what it saw either way. */
const rejected = (report, name, body) => {
  try {
    body();
    report.fail(name, 'succeeded, but the tampered input must not open');
  } catch (error) {
    report.value(name, `rejected (${error.name || 'Error'})`);
  }
};

/**
 * Runs every primitive check against an initialised `sodium` object.
 *
 * @param sodium an initialised libsodium-wrappers / -sumo instance
 * @param options.libraryName label recorded in the report
 * @param options.implementation what libsodium implementation was loaded
 * @returns {{lines: string[], failures: string[], gaps: string[]}}
 */
export async function runChecks(
  sodium,
  { libraryName, implementation, packageVersion },
) {
  const report = new Report();

  report.value('probe.library', libraryName);
  report.value('probe.package_version', packageVersion);
  report.value('probe.implementation', implementation);
  report.value('sodium.version_string', sodium.sodium_version_string());

  // --- which exports exist at all (recorded, never invoked for pwhash) ------
  for (const [group, names] of Object.entries(REQUIRED_EXPORTS)) {
    for (const name of names) {
      const present = has(sodium, name);
      report.value(`${group}.export.${name}`, present ? 'present' : 'absent');
      if (!present) {
        report.gaps.push(`${name} is missing from ${libraryName}`);
      }
    }
  }
  // Presence only: D-17 forbids deriving a key from the login password, so no
  // probe calls any of these — listing the export is as far as this goes.
  const pwhashKeys = Object.keys(sodium).filter((key) =>
    key.startsWith('crypto_pwhash'),
  );
  report.value(
    'crypto_pwhash.present',
    pwhashKeys.some(
      (key) => key === 'crypto_pwhash' || key === 'crypto_pwhash_str',
    )
      ? 'yes'
      : 'no',
  );
  report.value(
    'crypto_pwhash.argon2id_present',
    pwhashKeys.some((key) => key.startsWith('crypto_pwhash_argon2id')) ||
      pwhashKeys.includes('crypto_pwhash_ALG_ARGON2ID13')
      ? 'yes'
      : 'no',
  );
  report.value(
    'crypto_pwhash.called',
    'no (D-17: no key derives from the login password)',
  );

  // --- XChaCha20-Poly1305-IETF ---------------------------------------------
  const aead = {
    encrypt: 'crypto_aead_xchacha20poly1305_ietf_encrypt',
    decrypt: 'crypto_aead_xchacha20poly1305_ietf_decrypt',
    keybytes: 'crypto_aead_xchacha20poly1305_ietf_KEYBYTES',
    npubbytes: 'crypto_aead_xchacha20poly1305_ietf_NPUBBYTES',
    abytes: 'crypto_aead_xchacha20poly1305_ietf_ABYTES',
  };
  const aeadPrefix = 'aead.xchacha20poly1305_ietf';
  report.value(`${aeadPrefix}.key`, hex(FIXED.aeadKey));
  report.value(`${aeadPrefix}.nonce`, hex(FIXED.aeadNonce));
  report.value(`${aeadPrefix}.message`, hex(FIXED.message));
  report.value(`${aeadPrefix}.aad`, hex(FIXED.aad));
  if (sodium[aead.keybytes] !== undefined) {
    report.value(`${aeadPrefix}.key_bytes`, sodium[aead.keybytes]);
    report.value(`${aeadPrefix}.nonce_bytes`, sodium[aead.npubbytes]);
    report.value(`${aeadPrefix}.tag_bytes`, sodium[aead.abytes]);
  }
  if (has(sodium, aead.encrypt) && has(sodium, aead.decrypt)) {
    const cipherText = sodium[aead.encrypt](
      FIXED.message,
      FIXED.aad,
      null, // secret nonce: NSECBYTES is 0 for the IETF construction
      FIXED.aeadNonce,
      FIXED.aeadKey,
    );
    report.value(`${aeadPrefix}.ciphertext`, hex(cipherText));
    report.value(`${aeadPrefix}.ciphertext_bytes`, cipherText.length);

    // NOTE libsodium.js argument order: decrypt(secret_nonce, ciphertext,
    // additional_data, public_nonce, key) — the ciphertext is second.
    const plain = sodium[aead.decrypt](
      null,
      cipherText,
      FIXED.aad,
      FIXED.aeadNonce,
      FIXED.aeadKey,
    );
    report.value(`${aeadPrefix}.decrypted`, hex(plain));
    if (hex(plain) !== hex(FIXED.message)) {
      report.fail(`${aeadPrefix}.decrypt`, 'round trip returned other bytes');
    } else {
      report.ok(aeadPrefix);
    }

    const flippedTag = Uint8Array.from(cipherText);
    flippedTag[flippedTag.length - 1] ^= 0x01;
    rejected(report, `${aeadPrefix}.flipped_tag`, () =>
      sodium[aead.decrypt](
        null,
        flippedTag,
        FIXED.aad,
        FIXED.aeadNonce,
        FIXED.aeadKey,
      ),
    );

    const flippedAad = Uint8Array.from(FIXED.aad);
    flippedAad[0] ^= 0x01;
    rejected(report, `${aeadPrefix}.flipped_aad`, () =>
      sodium[aead.decrypt](
        null,
        cipherText,
        flippedAad,
        FIXED.aeadNonce,
        FIXED.aeadKey,
      ),
    );
  }

  // --- crypto_box_seal ------------------------------------------------------
  const sealPrefix = 'box.seal';
  if (has(sodium, 'crypto_box_seal') && has(sodium, 'crypto_box_seal_open')) {
    const recipient = sodium.crypto_box_keypair();
    const other = sodium.crypto_box_keypair();
    const sealed = sodium.crypto_box_seal(FIXED.message, recipient.publicKey);
    report.value(`${sealPrefix}.message_bytes`, FIXED.message.length);
    report.value(`${sealPrefix}.ciphertext_bytes`, sealed.length);
    report.value(
      `${sealPrefix}.overhead_bytes`,
      sealed.length - FIXED.message.length,
    );

    const opened = sodium.crypto_box_seal_open(
      sealed,
      recipient.publicKey,
      recipient.privateKey,
    );
    if (hex(opened) !== hex(FIXED.message)) {
      report.fail(`${sealPrefix}.roundtrip`, 'sealed box did not open');
    } else {
      report.ok(`${sealPrefix}.roundtrip`);
    }

    rejected(report, `${sealPrefix}.wrong_recipient`, () =>
      sodium.crypto_box_seal_open(sealed, other.publicKey, other.privateKey),
    );
  }

  // --- Ed25519 detached signatures -----------------------------------------
  const signPrefix = 'sign.ed25519';
  report.value(`${signPrefix}.seed`, hex(FIXED.ed25519Seed));
  report.value(`${signPrefix}.message`, hex(FIXED.message));
  if (
    has(sodium, 'crypto_sign_seed_keypair') &&
    has(sodium, 'crypto_sign_detached') &&
    has(sodium, 'crypto_sign_verify_detached')
  ) {
    const pair = sodium.crypto_sign_seed_keypair(FIXED.ed25519Seed);
    report.value(`${signPrefix}.public_key`, hex(pair.publicKey));
    const signature = sodium.crypto_sign_detached(
      FIXED.message,
      pair.privateKey,
    );
    report.value(`${signPrefix}.signature`, hex(signature));

    const verified = sodium.crypto_sign_verify_detached(
      signature,
      FIXED.message,
      pair.publicKey,
    );
    if (verified !== true) {
      report.fail(`${signPrefix}.verify`, 'detached signature did not verify');
    } else {
      report.ok(`${signPrefix}.verify`);
    }

    const flippedMessage = Uint8Array.from(FIXED.message);
    flippedMessage[0] ^= 0x01;
    let flippedVerified = true;
    try {
      flippedVerified = sodium.crypto_sign_verify_detached(
        signature,
        flippedMessage,
        pair.publicKey,
      );
    } catch {
      flippedVerified = false;
    }
    if (flippedVerified) {
      report.fail(`${signPrefix}.flipped_message`, 'verified a changed message');
    } else {
      report.value(`${signPrefix}.flipped_message`, 'rejected');
    }
  }

  // --- crypto_kdf (BLAKE2b derive_from_key) --------------------------------
  const kdfPrefix = 'kdf.derive_from_key';
  report.value(`${kdfPrefix}.master_key`, hex(FIXED.kdfMasterKey));
  report.value(`${kdfPrefix}.context`, FIXED.kdfContext);
  report.value(`${kdfPrefix}.subkey_id`, FIXED.kdfSubkeyId);
  if (has(sodium, 'crypto_kdf_derive_from_key')) {
    const subkey = sodium.crypto_kdf_derive_from_key(
      32,
      FIXED.kdfSubkeyId,
      FIXED.kdfContext,
      FIXED.kdfMasterKey,
    );
    report.value(`${kdfPrefix}.subkey`, hex(subkey));
    if (subkey.length !== 32) {
      report.fail(`${kdfPrefix}.subkey`, `expected 32 bytes, got ${subkey.length}`);
    } else {
      report.ok(kdfPrefix);
    }
  }

  // --- HKDF-SHA-256 ---------------------------------------------------------
  // libsodium-wrappers 0.8.4 exports the HKDF constants but not the functions,
  // so on the web the RFC vector is checked against Node's own RFC 5869
  // implementation. That is recorded as a gap, not as coverage of the library.
  const hkdfPrefix = 'kdf.hkdf_sha256';
  const { createHmac, hkdfSync } = await import('node:crypto');
  const hkdfInLibrary =
    has(sodium, 'crypto_kdf_hkdf_sha256_extract') &&
    has(sodium, 'crypto_kdf_hkdf_sha256_expand');
  report.value(`${hkdfPrefix}.in_library`, hkdfInLibrary ? 'yes' : 'no');
  for (const name of [
    'crypto_auth_hmacsha256',
    'crypto_auth_hmacsha256_init',
    'crypto_auth_hmacsha256_final',
    'crypto_auth_hmacsha256_verify',
  ]) {
    report.value(
      `${hkdfPrefix}.${name}`,
      has(sodium, name) ? 'present' : 'absent',
    );
  }
  report.value(
    `${hkdfPrefix}.hmac_sha256_in_library`,
    ['crypto_auth_hmacsha256', 'crypto_auth_hmacsha256_init'].every((name) =>
      has(sodium, name),
    )
      ? 'yes'
      : 'no',
  );

  if (hkdfInLibrary) {
    const prk = sodium.crypto_kdf_hkdf_sha256_extract(
      RFC5869_TC1.salt,
      RFC5869_TC1.ikm,
    );
    report.value(`${hkdfPrefix}.rfc5869_tc1_prk`, hex(prk));
    if (hex(prk) !== RFC5869_TC1.prk) {
      report.fail(`${hkdfPrefix}.extract`, 'PRK differs from RFC 5869 A.1');
    }
    const okm = sodium.crypto_kdf_hkdf_sha256_expand(
      prk,
      RFC5869_TC1.info,
      RFC5869_TC1.okmLength,
    );
    report.value(`${hkdfPrefix}.rfc5869_tc1_okm42`, hex(okm));
    if (hex(okm) !== RFC5869_TC1.okm) {
      report.fail(`${hkdfPrefix}.expand`, 'OKM differs from RFC 5869 A.1');
    }
  } else {
    report.value(`${hkdfPrefix}.usable`, 'no');
    report.gaps.push(
      `${hkdfPrefix}: ${libraryName} 0.8.4 exports the HKDF constants but not crypto_kdf_hkdf_sha256_extract/_expand`,
    );
    // Node's own HKDF is RFC 5869, so the vector still has a reference value —
    // and the TS library could build HKDF from HMAC-SHA-256 (present above).
    const prk = createHmac('sha256', Buffer.from(RFC5869_TC1.salt))
      .update(Buffer.from(RFC5869_TC1.ikm))
      .digest();
    const okm = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(RFC5869_TC1.ikm),
        Buffer.from(RFC5869_TC1.salt),
        Buffer.from(RFC5869_TC1.info),
        RFC5869_TC1.okmLength,
      ),
    );
    report.value(`${hkdfPrefix}.rfc5869_tc1_prk_node_crypto`, prk.toString('hex'));
    report.value(`${hkdfPrefix}.rfc5869_tc1_okm42_node_crypto`, okm.toString('hex'));
    if (prk.toString('hex') !== RFC5869_TC1.prk) {
      report.fail(`${hkdfPrefix}.prk_node_crypto`, 'differs from RFC 5869 A.1');
    }
    if (okm.toString('hex') !== RFC5869_TC1.okm) {
      report.fail(`${hkdfPrefix}.okm_node_crypto`, 'differs from RFC 5869 A.1');
    }

    // RFC 5869 A.3 (empty salt, empty info) as well, because that is the one
    // the Dart API can express end to end — and the same expansion with a
    // 10-byte ASCII info, which is what the Dart probe prints.
    // A.3's salt "not provided" is HashLen zero bytes for HMAC-SHA-256.
    const tc3Prk = createHmac('sha256', Buffer.alloc(32))
      .update(Buffer.from(RFC5869_TC3.ikm))
      .digest()
      .toString('hex');
    report.value(`${hkdfPrefix}.rfc5869_tc3_prk_node_crypto`, tc3Prk);
    if (tc3Prk !== RFC5869_TC3.prk) {
      report.fail(`${hkdfPrefix}.tc3_prk_node_crypto`, 'differs from RFC 5869 A.3');
    }
    const okmOf = (salt, info) =>
      Buffer.from(
        hkdfSync(
          'sha256',
          Buffer.from(RFC5869_TC3.ikm),
          Buffer.from(salt),
          Buffer.from(info),
          RFC5869_TC3.okmLength,
        ),
      ).toString('hex');
    const tc3Okm = okmOf(RFC5869_TC3.salt, RFC5869_TC3.info);
    report.value(`${hkdfPrefix}.rfc5869_tc3_okm42_node_crypto`, tc3Okm);
    if (tc3Okm !== RFC5869_TC3.okm) {
      report.fail(
        `${hkdfPrefix}.tc3_okm_node_crypto`,
        'differs from RFC 5869 A.3',
      );
    }
    report.value(`${hkdfPrefix}.ascii_info`, ASCII_HKDF_INFO);
    report.value(
      `${hkdfPrefix}.ascii_info_okm42_node_crypto`,
      okmOf(RFC5869_TC3.salt, Buffer.from(ASCII_HKDF_INFO, 'utf8')),
    );
  }

  // --- randombytes_buf ------------------------------------------------------
  const randomPrefix = 'randombytes.buf';
  if (has(sodium, 'randombytes_buf')) {
    const first = sodium.randombytes_buf(32);
    const second = sodium.randombytes_buf(32);
    report.value(`${randomPrefix}.length`, first.length);
    report.value(`${randomPrefix}.two_draws_differ`, hex(first) === hex(second) ? 'no' : 'yes');
    report.value(
      `${randomPrefix}.not_all_zero`,
      first.every((byte) => byte === 0) ? 'no' : 'yes',
    );
    if (hex(first) === hex(second)) {
      report.fail(randomPrefix, 'two RNG draws were identical');
    }
  }

  report.value(`${aeadPrefix}.available`, has(sodium, aead.encrypt) ? 'yes' : 'no');
  return report;
}
