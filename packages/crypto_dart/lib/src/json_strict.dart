/// A JSON reader strict enough for `spec/crypto.md` §4.
///
/// `dart:convert`'s `jsonDecode` is not usable for a payload, for two reasons the
/// spec names explicitly:
///
/// * it silently keeps the last of two members with one name, so two different
///   plaintexts would open as the same object (§4.2), and
/// * it accepts spellings of a number (`1e2`, `1.0`) the format has no canonical
///   form for.
///
/// So the payload is parsed here instead: at any depth, a repeated member name is
/// an error, and a number is an integer literal or an error. The canonicality
/// check itself is a re-serialisation with [jcsSerialise] compared against the
/// original bytes, which rejects any other spelling (member order, escapes,
/// whitespace).
library;

/// Thrown for any input this reader refuses. Callers map it to
/// [CryptoError.payload].
class JsonStrictException implements Exception {
  const JsonStrictException(this.message);

  final String message;

  @override
  String toString() => 'JsonStrictException: $message';
}

/// Parses [text] as one JSON value and refuses anything left over.
///
/// Objects come back as `Map<String, Object?>` in the order the members appeared,
/// arrays as `List<Object?>`, numbers as `int` or `double`, and `true`/`false`/
/// `null` as themselves.
Object? jsonParseStrict(String text) {
  final parser = _Parser(text);
  parser.skipWhitespace();
  final value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.atEnd) {
    throw const JsonStrictException('trailing data after the JSON value');
  }
  return value;
}

bool _isHex4(String value) {
  if (value.length != 4) return false;
  for (var i = 0; i < 4; i++) {
    final unit = value.codeUnitAt(i);
    final isDigit = unit >= 0x30 && unit <= 0x39;
    final isLower = unit >= 0x61 && unit <= 0x66;
    final isUpper = unit >= 0x41 && unit <= 0x46;
    if (!isDigit && !isLower && !isUpper) return false;
  }
  return true;
}

class _Parser {
  _Parser(this.text);

  final String text;
  int index = 0;

  bool get atEnd => index >= text.length;

  int get _peek {
    if (atEnd) throw const JsonStrictException('unexpected end of input');
    return text.codeUnitAt(index);
  }

  void skipWhitespace() {
    while (!atEnd) {
      final unit = text.codeUnitAt(index);
      if (unit == 0x20 || unit == 0x09 || unit == 0x0a || unit == 0x0d) {
        index++;
      } else {
        return;
      }
    }
  }

  Object? parseValue() {
    if (atEnd) throw const JsonStrictException('unexpected end of input');
    switch (_peek) {
      case 0x7b: // {
        return _parseObject();
      case 0x5b: // [
        return _parseArray();
      case 0x22: // "
        return _parseString();
      case 0x74: // t
        return _parseLiteral('true', true);
      case 0x66: // f
        return _parseLiteral('false', false);
      case 0x6e: // n
        return _parseLiteral('null', null);
      default:
        return _parseNumber();
    }
  }

  Map<String, Object?> _parseObject() {
    index++; // {
    final members = <String, Object?>{};
    skipWhitespace();
    if (!atEnd && _peek == 0x7d) {
      index++;
      return members;
    }
    while (true) {
      skipWhitespace();
      if (atEnd || _peek != 0x22) {
        throw const JsonStrictException('a member name must be a string');
      }
      final name = _parseString();
      if (members.containsKey(name)) {
        // A JSON parser keeps only the last member, so two spellings of one
        // payload would otherwise open as the same object (§4.2).
        throw const JsonStrictException('duplicate member name');
      }
      skipWhitespace();
      if (atEnd || _peek != 0x3a) {
        throw const JsonStrictException("expected ':' after a member name");
      }
      index++;
      skipWhitespace();
      members[name] = parseValue();
      skipWhitespace();
      if (atEnd) throw const JsonStrictException('unterminated object');
      if (_peek == 0x2c) {
        index++;
        continue;
      }
      if (_peek == 0x7d) {
        index++;
        return members;
      }
      throw const JsonStrictException("expected ',' or '}' in an object");
    }
  }

  List<Object?> _parseArray() {
    index++; // [
    final items = <Object?>[];
    skipWhitespace();
    if (!atEnd && _peek == 0x5d) {
      index++;
      return items;
    }
    while (true) {
      skipWhitespace();
      items.add(parseValue());
      skipWhitespace();
      if (atEnd) throw const JsonStrictException('unterminated array');
      if (_peek == 0x2c) {
        index++;
        continue;
      }
      if (_peek == 0x5d) {
        index++;
        return items;
      }
      throw const JsonStrictException("expected ',' or ']' in an array");
    }
  }

  String _parseString() {
    index++; // opening quote
    final out = StringBuffer();
    while (true) {
      if (atEnd) throw const JsonStrictException('unterminated string');
      final unit = text.codeUnitAt(index);
      if (unit == 0x22) {
        index++;
        return out.toString();
      }
      if (unit == 0x5c) {
        index++;
        if (atEnd) throw const JsonStrictException('unterminated escape');
        final escape = text.codeUnitAt(index);
        if (escape == 0x22) {
          out.write('"');
        } else if (escape == 0x5c) {
          out.write(r'\');
        } else if (escape == 0x2f) {
          out.write('/');
        } else if (escape == 0x62) {
          out.write('\b');
        } else if (escape == 0x66) {
          out.write('\f');
        } else if (escape == 0x6e) {
          out.write('\n');
        } else if (escape == 0x72) {
          out.write('\r');
        } else if (escape == 0x74) {
          out.write('\t');
        } else if (escape == 0x75) {
          if (index + 5 > text.length) {
            throw const JsonStrictException('truncated \\u escape');
          }
          final hex = text.substring(index + 1, index + 5);
          if (!_isHex4(hex)) {
            throw const JsonStrictException('malformed \\u escape');
          }
          out.writeCharCode(int.parse(hex, radix: 16));
          index += 4;
        } else {
          throw const JsonStrictException('unknown escape in a string');
        }
        index++;
        continue;
      }
      if (unit < 0x20) {
        throw const JsonStrictException('unescaped control character');
      }
      out.writeCharCode(unit);
      index++;
    }
  }

  Object? _parseLiteral(String literal, Object? value) {
    if (!text.startsWith(literal, index)) {
      throw JsonStrictException('expected $literal');
    }
    index += literal.length;
    return value;
  }

  Object? _parseNumber() {
    final start = index;
    if (!atEnd && _peek == 0x2d) index++; // -
    if (atEnd) throw const JsonStrictException('truncated number');
    if (_peek == 0x30) {
      index++;
    } else if (_peek >= 0x31 && _peek <= 0x39) {
      while (!atEnd && _peek >= 0x30 && _peek <= 0x39) {
        index++;
      }
    } else {
      throw const JsonStrictException('expected a digit');
    }
    var isInteger = true;
    if (!atEnd && _peek == 0x2e) {
      isInteger = false;
      index++;
      if (atEnd || _peek < 0x30 || _peek > 0x39) {
        throw const JsonStrictException('expected a digit after the point');
      }
      while (!atEnd && _peek >= 0x30 && _peek <= 0x39) {
        index++;
      }
    }
    if (!atEnd && (_peek == 0x65 || _peek == 0x45)) {
      isInteger = false;
      index++;
      if (!atEnd && (_peek == 0x2b || _peek == 0x2d)) index++;
      if (atEnd || _peek < 0x30 || _peek > 0x39) {
        throw const JsonStrictException('expected a digit in the exponent');
      }
      while (!atEnd && _peek >= 0x30 && _peek <= 0x39) {
        index++;
      }
    }
    final literal = text.substring(start, index);
    if (!isInteger) {
      // A float or an exponent form: kept as a double so the type check can
      // refuse it with the code the spec gives that case (§4.2).
      final parsed = double.tryParse(literal);
      if (parsed == null) {
        throw const JsonStrictException('malformed number');
      }
      return parsed;
    }
    final parsed = int.tryParse(literal);
    if (parsed == null) {
      throw const JsonStrictException('integer outside the supported range');
    }
    return parsed;
  }
}
