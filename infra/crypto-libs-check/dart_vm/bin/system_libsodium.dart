// E12-R02 crypto-libs probe — which system libsodium the dev host has.
//
// Run from `infra/crypto-libs-check/dart_vm`:
//   dart run bin/system_libsodium.dart
//
// This answers the "does `sodium` bind the host's libsodium?" question with a
// measurement rather than an assumption. It loads `/usr/lib/libsodium.so.26`
// directly through `dart:ffi` and reports its version plus whether each
// primitive E12-R02 names is exported by it. Symbol presence only — every
// behavioural check lives in `bin/probe.dart`, which uses the library the
// `sodium` package actually builds and links.

import 'dart:ffi';

import 'package:ffi/ffi.dart';

import 'dart:io';

typedef _VersionStringNative = Pointer<Utf8> Function();
typedef _VersionStringDart = Pointer<Utf8> Function();
typedef _VersionPartNative = Int32 Function();
typedef _VersionPartDart = int Function();
typedef _InitNative = Int32 Function();
typedef _InitDart = int Function();

/// Symbols of the primitives E12-R02 asks about, as the C library spells them.
const List<String> probedSymbols = <String>[
  'crypto_aead_xchacha20poly1305_ietf_encrypt',
  'crypto_aead_xchacha20poly1305_ietf_decrypt',
  'crypto_box_seal',
  'crypto_box_seal_open',
  'crypto_sign_detached',
  'crypto_sign_verify_detached',
  'crypto_kdf_derive_from_key',
  'crypto_kdf_hkdf_sha256_extract',
  'crypto_kdf_hkdf_sha256_expand',
  'crypto_auth_hmacsha256_init',
  'randombytes_buf',
  'sodium_version_string',
  // Presence only: D-17 forbids deriving a key from the login password, so this
  // symbol is never called anywhere in the probe.
  'crypto_pwhash',
];

void main() {
  final candidates = <String>[
    '/usr/lib/libsodium.so.26',
    '/usr/lib/libsodium.so',
    '/lib/x86_64-linux-gnu/libsodium.so.26',
    'libsodium.so.26',
  ];

  DynamicLibrary? library;
  for (final candidate in candidates) {
    try {
      library = DynamicLibrary.open(candidate);
      stdout.writeln('system_libsodium.path=$candidate');
      break;
    } on ArgumentError catch (error) {
      stdout.writeln('system_libsodium.path.$candidate=not loadable ($error)');
    }
  }

  if (library == null) {
    stdout.writeln('system_libsodium=unavailable');
    exitCode = 1;
    return;
  }

  final init = library.lookupFunction<_InitNative, _InitDart>('sodium_init');
  stdout.writeln('system_libsodium.sodium_init=${init()}');

  final versionString = library
      .lookupFunction<_VersionStringNative, _VersionStringDart>(
        'sodium_version_string',
      )();
  stdout.writeln(
    'system_libsodium.version_string=${versionString.toDartString()}',
  );
  stdout.writeln(
    'system_libsodium.library_version='
    '${library.lookupFunction<_VersionPartNative, _VersionPartDart>('sodium_library_version_major')()}'
    '.'
    '${library.lookupFunction<_VersionPartNative, _VersionPartDart>('sodium_library_version_minor')()}',
  );

  var missing = 0;
  for (final symbol in probedSymbols) {
    try {
      library.lookup(symbol);
      stdout.writeln('system_libsodium.symbol.$symbol=present');
    } on ArgumentError {
      stdout.writeln('system_libsodium.symbol.$symbol=absent');
      missing++;
    }
  }
  stdout.writeln('system_libsodium.symbols_missing=$missing');
  stdout.writeln(
    'system_libsodium.note=loaded directly with DynamicLibrary.open; the '
    '`sodium` 4.x package does not use it (see probe.dart)',
  );
}
