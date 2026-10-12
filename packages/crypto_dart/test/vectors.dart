/// Loads the frozen cross-language vectors from `spec/crypto-vectors/`.
///
/// The files are read from the repository, never copied into this package
/// (E12-R03): a copy would let the library and the vectors drift apart, and the
/// TypeScript library in Phase 5 is held to the same bytes.
///
/// `dart test` runs with the package directory as its working directory, so the
/// repository root is `../..` from here.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto_dart/crypto_dart.dart';

/// The one directory the vectors live in, relative to the package root.
final Directory vectorDirectory = Directory('../../spec/crypto-vectors');

/// One vector of a `*-v1.json` file.
class Vector {
  Vector({
    required this.file,
    required this.id,
    required this.kind,
    required this.op,
    required this.purpose,
    required this.inputs,
    required this.expected,
  });

  /// The file's name, e.g. `envelope-v1.json`.
  final String file;

  /// The vector's id, e.g. `envelope-open-tag-flipped`.
  final String id;

  /// `positive` or `negative`.
  final String kind;

  /// The entry point the vector exercises.
  final String op;

  /// One line, in the spec's vocabulary.
  final String purpose;

  /// The operation's inputs, in `crypto-vectors/README.md`'s vocabulary.
  final Map<String, Object?> inputs;

  /// The pinned output, or `{"error": "E_…"}`.
  final Map<String, Object?> expected;

  bool get isPositive => kind == 'positive';

  bool get isNegative => kind == 'negative';

  /// The error code a negative vector pins.
  CryptoError get pinnedError {
    final code = expected['error'];
    if (code is! String) {
      throw StateError('$file/$id is negative but pins no error code');
    }
    for (final error in CryptoError.values) {
      if (error.code == code) return error;
    }
    throw StateError('$file/$id pins an unknown error code: $code');
  }

  /// A byte-string input, e.g. `cck_hex`.
  Uint8List hex(String key) {
    final value = inputs[key];
    if (value is! String) {
      throw StateError('$file/$id has no $key');
    }
    return hexToBytes(value);
  }

  /// A text input.
  String text(String key) {
    final value = inputs[key];
    if (value is! String) {
      throw StateError('$file/$id has no $key');
    }
    return value;
  }

  /// An integer input.
  int integer(String key) {
    final value = inputs[key];
    if (value is! int) {
      throw StateError('$file/$id has no integer $key');
    }
    return value;
  }

  /// A `{"@type": …}` payload object input.
  Map<String, Object?> payloadObject() {
    final value = inputs['payload_object'];
    if (value is! Map<String, Object?>) {
      throw StateError('$file/$id has no payload_object');
    }
    return value;
  }

  @override
  String toString() => '$file/$id';
}

/// Loads one vector file, checking its envelope.
List<Vector> loadVectors(String fileName) {
  if (!vectorDirectory.existsSync()) {
    throw StateError(
      'the frozen vectors are not at ${vectorDirectory.absolute.path}; '
      'run `dart test` from packages/crypto_dart',
    );
  }
  final file = File('${vectorDirectory.path}/$fileName');
  final document = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
  if (document['format'] != 'calflex-crypto-vectors/1') {
    throw StateError('$fileName is not a calflex-crypto-vectors/1 document');
  }
  final vectors = <Vector>[];
  for (final raw in document['vectors'] as List<Object?>) {
    final vector = raw as Map<String, Object?>;
    vectors.add(
      Vector(
        file: fileName,
        id: vector['id'] as String,
        kind: vector['kind'] as String,
        op: vector['op'] as String,
        purpose: vector['purpose'] as String,
        inputs: vector['inputs'] as Map<String, Object?>,
        expected: (vector['expected'] as Map<String, Object?>?) ?? const {},
      ),
    );
  }
  if (vectors.isEmpty) {
    // A test over an empty list proves nothing.
    throw StateError('$fileName contributed no vectors');
  }
  return vectors;
}

/// Prints what a file contributed, so an empty or shrinking file is visible in
/// the test log.
void reportVectors(String fileName, List<Vector> vectors) {
  final positives = vectors.where((vector) => vector.isPositive).length;
  final byOp = <String, int>{};
  for (final vector in vectors) {
    byOp[vector.op] = (byOp[vector.op] ?? 0) + 1;
  }
  final ops = (byOp.keys.toList()..sort())
      .map((op) => '$op=${byOp[op]}')
      .join(', ');
  print(
    '$fileName: ${vectors.length} vectors '
    '($positives positive, ${vectors.length - positives} negative) — $ops',
  );
}

/// Lowercase hex to bytes, refusing anything else.
Uint8List hexToBytes(String value) {
  if (value.length.isOdd || !RegExp(r'^[0-9a-f]*$').hasMatch(value)) {
    throw StateError('not lowercase hex: $value');
  }
  final out = Uint8List(value.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(value.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

/// Runs [body] and returns the code it refused with, or `null` if it did not
/// refuse at all.
CryptoError? refusalOf(void Function() body) {
  try {
    body();
    return null;
  } on CryptoException catch (error) {
    return error.error;
  } on JcsUnsupported {
    // The serialiser refuses a value §4.1 has no form for; the payload is the
    // thing that is wrong.
    return CryptoError.payload;
  }
}

/// Fails unless [body] refuses with exactly [code].
///
/// A negative vector's `expected` is exactly the code: a partial result where an
/// error is expected is a bug, not a near miss.
void expectRefusal(CryptoError code, void Function() body, String what) {
  final refused = refusalOf(body);
  if (refused != code) {
    throw StateError(
      '$what: expected ${code.code}, got ${refused?.code ?? "no refusal"}',
    );
  }
}
