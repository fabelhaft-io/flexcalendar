import 'dart:convert';
import 'dart:typed_data';

/// Thrown by [jcsSerialise] for a value RFC 8785 cannot write, or that the
/// payload format (`spec/crypto.md` §4) forbids. Callers map it to
/// [CryptoError.payload].
class JcsUnsupported implements Exception {
  const JcsUnsupported(this.message);

  final String message;

  @override
  String toString() => 'JcsUnsupported: $message';
}

/// The largest integer the payload format allows, `2^53 − 1` (§4.2).
const int maxSafeInteger = 9007199254740991;

/// The JCS (RFC 8785) serialisation of [value], per `spec/crypto.md` §4.1.
///
/// Written out rather than taken from a package: the rules the format depends on
/// (UTF-16 member order, the short escapes, raw UTF-8 for everything else,
/// integers only) are a compatibility surface both libraries must hit exactly,
/// so they are held to `spec/crypto-vectors/payload-jcs-v1.json` instead of to a
/// third party's idea of canonical JSON.
///
/// Throws [JcsUnsupported] for a value outside §4.1: a double, an integer
/// outside the safe range, a lone surrogate, a non-string member name or a
/// value that is not JSON at all.
String jcsSerialise(Object? value) {
  final out = StringBuffer();
  _write(out, value);
  return out.toString();
}

/// The UTF-8 bytes of [jcsSerialise]: the plaintext of an envelope (§4).
Uint8List jcsEncode(Object? value) =>
    Uint8List.fromList(utf8.encode(jcsSerialise(value)));

void _write(StringBuffer out, Object? value) {
  if (value == null) {
    out.write('null');
  } else if (value is bool) {
    out.write(value ? 'true' : 'false');
  } else if (value is int) {
    out.write(_number(value));
  } else if (value is String) {
    _writeString(out, value);
  } else if (value is List) {
    out.write('[');
    for (var i = 0; i < value.length; i++) {
      if (i > 0) out.write(',');
      _write(out, value[i]);
    }
    out.write(']');
  } else if (value is Map) {
    final keys = <String>[];
    for (final key in value.keys) {
      if (key is! String) {
        throw JcsUnsupported('member names must be strings: $key');
      }
      keys.add(key);
    }
    // RFC 8785 §3.2.3: sort by UTF-16 code unit. Dart's `String.compareTo`
    // compares code units, which differs from code-point order above U+FFFF.
    keys.sort();
    out.write('{');
    for (var i = 0; i < keys.length; i++) {
      if (i > 0) out.write(',');
      _writeString(out, keys[i]);
      out.write(':');
      _write(out, value[keys[i]]);
    }
    out.write('}');
  } else {
    throw JcsUnsupported('unsupported JSON value: ${value.runtimeType}');
  }
}

String _number(int value) {
  if (value < -maxSafeInteger || value > maxSafeInteger) {
    throw JcsUnsupported('integer outside the IEEE-754 safe range: $value');
  }
  return value.toString();
}

void _writeString(StringBuffer out, String value) {
  out.write('"');
  for (var i = 0; i < value.length; i++) {
    final unit = value.codeUnitAt(i);
    if (unit == 0x22) {
      out.write(r'\"');
    } else if (unit == 0x5c) {
      out.write(r'\\');
    } else if (unit == 0x08) {
      out.write(r'\b');
    } else if (unit == 0x09) {
      out.write(r'\t');
    } else if (unit == 0x0a) {
      out.write(r'\n');
    } else if (unit == 0x0c) {
      out.write(r'\f');
    } else if (unit == 0x0d) {
      out.write(r'\r');
    } else if (unit < 0x20) {
      // ES6 JSON.stringify: every remaining C0 control is \u00xx, lowercase.
      out.write('\\u${unit.toRadixString(16).padLeft(4, '0')}');
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      final next = i + 1 < value.length ? value.codeUnitAt(i + 1) : 0;
      final isHigh = unit <= 0xdbff;
      final lowFollows = next >= 0xdc00 && next <= 0xdfff;
      if (!isHigh || !lowFollows) {
        throw const JcsUnsupported('lone surrogate in a string');
      }
      // A well-formed pair is emitted as its raw UTF-8, like any other
      // non-ASCII character.
      out.writeCharCode(unit);
      out.writeCharCode(next);
      i++;
    } else {
      // Everything else, U+2028 and U+2029 included, is written as raw UTF-8.
      out.writeCharCode(unit);
    }
  }
  out.write('"');
}
