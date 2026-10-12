// INV-04's guard: no device-local `DateTime` in the domain layer (E10-R04).
//
// A unit test, not a lint package: `make verify-mobile` runs it with the rest of
// `flutter test`, and `analysis_options.yaml` needs no plugin. The check is an
// AST walk (the analyzer is already a dev dependency, pinned at 13.3.0), so a
// string in a comment cannot trip it and a real call cannot hide in a wrapper.
//
// What it reports, all of it from INV-04 and `docs/02` § Mobile clients:
//   * a bare `DateTime(...)` (the local-zone constructor; `DateTime.utc` is
//     fine, it reads no zone),
//   * `DateTime.now()`,
//   * `.toLocal()`,
//   * `add`/`subtract`/`difference` on a plain `DateTime` — the arithmetic
//     INV-04 bans, because a `DateTime` in a zone does not know the zone,
//   * `DateTime.fromMillisecondsSinceEpoch`/`fromMicrosecondsSinceEpoch`
//     without `isUtc: true`, which read the device's zone.
//
// A deliberate exception is named in `AllowedUse`, with the reason. The app's
// own list is empty — the domain layer needs no local reading; the planted
// fixture proves that the mechanism suppresses what it names.

import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:analyzer/source/line_info.dart';

/// One device-local `DateTime` use in a file that must not have one.
class LocalZoneDateTimeUse {
  const LocalZoneDateTimeUse({
    required this.path,
    required this.line,
    required this.symbol,
  });

  /// The file, as it was passed to [findLocalZoneDateTimeUses].
  final String path;

  /// The 1-based line of the use.
  final int line;

  /// The construct, e.g. `DateTime.now()`.
  final String symbol;

  @override
  String toString() => '$path:$line: $symbol';
}

/// A use the guard lets through, and why.
class AllowedUse {
  const AllowedUse({
    required this.path,
    required this.symbol,
    required this.why,
  });

  final String path;
  final String symbol;
  final String why;
}

/// The constructs the guard reports, so a test can assert each one is caught.
const guardedSymbols = <String>[
  'DateTime(...)',
  'DateTime.now()',
  'toLocal()',
  'DateTime.add|subtract|difference',
  'DateTime.fromMillisecondsSinceEpoch without isUtc: true',
];

/// Every device-local `DateTime` use in [source], minus the [allowList].
List<LocalZoneDateTimeUse> findLocalZoneDateTimeUses({
  required String path,
  required String source,
  List<AllowedUse> allowList = const [],
}) {
  final parsed = parseString(
    content: source,
    path: path,
    throwIfDiagnostics: false,
  );
  if (parsed.errors.isNotEmpty) {
    throw ArgumentError(
      'the guard could not parse $path: '
      '${parsed.errors.map((error) => error.message).join('; ')}',
    );
  }
  final unit = parsed.unit;
  final names = _PlainDateTimeNames();
  unit.accept(names);
  final collector = _UseCollector(path, parsed.lineInfo, names.names);
  unit.accept(collector);
  return [
    for (final use in collector.uses)
      if (!allowList.any(
        (allowed) => allowed.path == path && allowed.symbol == use.symbol,
      ))
        use,
  ];
}

/// The names in one file that hold a plain (device-local) `DateTime`: a local,
/// a field or a parameter declared with the type `DateTime`.
class _PlainDateTimeNames extends RecursiveAstVisitor<void> {
  final names = <String>{};

  @override
  void visitVariableDeclarationList(VariableDeclarationList node) {
    if (_isDateTimeType(node.type)) {
      for (final declaration in node.variables) {
        names.add(declaration.name.lexeme);
      }
    }
    super.visitVariableDeclarationList(node);
  }

  @override
  void visitRegularFormalParameter(RegularFormalParameter node) {
    final name = node.name;
    if (name != null && _isDateTimeType(node.type)) {
      names.add(name.lexeme);
    }
    super.visitRegularFormalParameter(node);
  }

  @override
  void visitFieldDeclaration(FieldDeclaration node) {
    if (_isDateTimeType(node.fields.type)) {
      for (final declaration in node.fields.variables) {
        names.add(declaration.name.lexeme);
      }
    }
    super.visitFieldDeclaration(node);
  }
}

class _UseCollector extends RecursiveAstVisitor<void> {
  _UseCollector(this.path, this.lineInfo, this.plainNames);

  final String path;
  final LineInfo lineInfo;
  final Set<String> plainNames;
  final uses = <LocalZoneDateTimeUse>[];

  @override
  void visitInstanceCreationExpression(InstanceCreationExpression node) {
    // `new DateTime(...)` is an instance creation; the bare form is not (see
    // `visitMethodInvocation`).
    final type = node.constructorName.type;
    if (_isDateTimeName(type)) {
      final constructor = node.constructorName.name?.name;
      if (constructor == null || constructor == 'new') {
        _add(node, 'DateTime(...)');
      } else if (constructor == 'fromMillisecondsSinceEpoch' ||
          constructor == 'fromMicrosecondsSinceEpoch') {
        if (!_hasIsUtcTrue(node.argumentList)) {
          _add(node, 'DateTime.$constructor without isUtc: true');
        }
      }
    }
    super.visitInstanceCreationExpression(node);
  }

  @override
  void visitMethodInvocation(MethodInvocation node) {
    final target = node.realTarget;
    final name = node.methodName.name;
    if (target == null && name == 'DateTime') {
      // `DateTime(...)`: the constructor that reads the device's zone. The
      // parser models a constructor call as an invocation, not as an instance
      // creation — `DateTime.utc(...)` is here too, with a target, and is not
      // reported.
      _add(node, 'DateTime(...)');
    } else if (_isDateTimeIdentifier(target) &&
        (name == 'fromMillisecondsSinceEpoch' ||
            name == 'fromMicrosecondsSinceEpoch')) {
      if (!_hasIsUtcTrue(node.argumentList)) {
        _add(node, 'DateTime.$name without isUtc: true');
      }
    } else if (name == 'now' && _isDateTimeIdentifier(target)) {
      _add(node, 'DateTime.now()');
    } else if (name == 'toLocal') {
      _add(node, 'toLocal()');
    } else if (name == 'add' || name == 'subtract' || name == 'difference') {
      if (_isPlainDateTime(target)) {
        _add(node, 'DateTime.add|subtract|difference');
      }
    }
    super.visitMethodInvocation(node);
  }

  /// Whether [node] produces a plain `DateTime`, whose zone is the device's.
  bool _isPlainDateTime(Expression? node) {
    if (node == null) {
      return false;
    }
    if (node is SimpleIdentifier) {
      return plainNames.contains(node.name) || node.name == 'DateTime';
    }
    if (node is InstanceCreationExpression) {
      final type = node.constructorName.type;
      final constructor = node.constructorName.name?.name;
      return _isDateTimeName(type) &&
          (constructor == null || constructor == 'new');
    }
    if (node is MethodInvocation) {
      // `DateTime.parse(…)` without a `Z`, and `DateTime.tryParse`, read the
      // device's zone; `DateTime.utc(…)` does not, which is why it is not here.
      return _isDateTimeIdentifier(node.realTarget) &&
          (node.methodName.name == 'parse' ||
              node.methodName.name == 'tryParse');
    }
    if (node is ParenthesizedExpression) {
      return _isPlainDateTime(node.expression);
    }
    return false;
  }

  bool _isDateTimeIdentifier(Expression? node) =>
      node is SimpleIdentifier && node.name == 'DateTime';

  bool _hasIsUtcTrue(ArgumentList arguments) => arguments.arguments.any(
    (argument) =>
        argument is NamedArgument &&
        argument.name.lexeme == 'isUtc' &&
        argument.argumentExpression is BooleanLiteral &&
        (argument.argumentExpression as BooleanLiteral).value,
  );

  void _add(AstNode node, String symbol) {
    uses.add(
      LocalZoneDateTimeUse(
        path: path,
        line: lineInfo.getLocation(node.offset).lineNumber,
        symbol: symbol,
      ),
    );
  }
}

bool _isDateTimeType(TypeAnnotation? type) =>
    type is NamedType && _isDateTimeName(type);

bool _isDateTimeName(NamedType type) =>
    type.name.lexeme == 'DateTime' && type.importPrefix == null;
