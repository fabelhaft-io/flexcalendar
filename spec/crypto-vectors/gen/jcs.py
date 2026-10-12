"""RFC 8785 (JCS) serialiser — hand-written, for the reference vectors only.

Why hand-written: `spec/crypto.md` §4.1 is a contract the Dart and TS libraries must both hit, and
the fastest way to notice that this file and `rfc8785` disagree is to run them against each other.
`generate.py` does exactly that on every payload it emits (see `cross_check_jcs`). Neither this
module nor `rfc8785` is part of the libraries; they exist so the vectors come from something other
than the code under test.

Scope: the JSON subset `spec/crypto.md` §4 allows — objects, arrays, strings, booleans and
integers. `null` is serialised (for the cross-check) but a *payload* carrying one is refused by the
caller. Floats and lone surrogates raise, because RFC 8785's ECMAScript number and string rules are
not implemented here and the payload format forbids them anyway (§4.2).
"""

from __future__ import annotations

import json

MAX_SAFE_INTEGER = 2**53 - 1

_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
}


def _string(value: str) -> str:
    out = ['"']
    for ch in value:
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif ch < " ":
            # ES6 JSON.stringify: every remaining C0 control is \u00xx, lowercase hex.
            out.append(f"\\u{ord(ch):04x}")
        elif 0xD800 <= ord(ch) <= 0xDFFF:
            raise ValueError(f"lone surrogate in string: {value!r}")
        else:
            # Everything else, U+2028 and U+2029 included, is emitted as raw UTF-8.
            out.append(ch)
    out.append('"')
    return "".join(out)


def _number(value: object) -> str:
    if isinstance(value, bool):  # bool is an int subclass; handled by the caller
        raise TypeError("bool is not a number")
    if isinstance(value, int):
        if not -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
            raise ValueError(f"integer outside the IEEE-754 safe range: {value!r}")
        return str(value)
    raise ValueError(f"only integers are serialised (spec/crypto.md §4.1): {value!r}")


def _serialise(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return _number(value)
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_serialise(item) for item in value) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise TypeError(f"member names must be strings: {key!r}")
        # RFC 8785 §3.2.3: sort by UTF-16 code unit. utf-16-be bytes compare in that order,
        # which differs from code-point order for the astral plane.
        keys = sorted(value, key=lambda key: key.encode("utf-16-be"))
        members = [f'"{_string(key)[1:-1]}":{_serialise(value[key])}' for key in keys]
        return "{" + ",".join(members) + "}"
    raise ValueError(f"unsupported JSON value: {value!r}")


def dumps(value: object) -> bytes:
    """The JCS serialisation of `value`, as UTF-8 bytes (no BOM, no trailing newline)."""
    return _serialise(value).encode("utf-8")


def compare_with_rfc8785(value: object) -> None:
    """Raise if this serialiser and the `rfc8785` package disagree on `value`.

    Imported lazily so a machine without the package can still regenerate the vectors — the
    cross-check is evidence, not a build step.
    """
    import rfc8785  # type: ignore[import-not-found]

    mine = dumps(value)
    theirs = rfc8785.dumps(value)
    if mine != theirs:
        raise AssertionError(
            f"JCS disagreement:\n  hand-written: {mine!r}\n  rfc8785:      {theirs!r}"
        )


def loads(text: str) -> object:
    return json.loads(text)
