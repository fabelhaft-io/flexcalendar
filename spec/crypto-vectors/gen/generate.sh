#!/bin/sh
# One command that regenerates every vector in `spec/crypto-vectors/` from fixed, invented
# inputs (E12-R01).
#
#   spec/crypto-vectors/gen/generate.sh            regenerate in place
#   spec/crypto-vectors/gen/generate.sh --check    fail if the committed files differ
#
# The environment lives outside the repository (`$CALFLEX_VECTOR_VENV`, default below
# `~/.cache/flexcalendar-agent-team/`), because an SDK unpacked into a writable path ends up
# in git. `uv` is the only prerequisite; `uv venv` + `uv pip install --require-hashes` pin
# every artefact by SHA-256 (see `requirements.txt`).
set -eu

# Importing jcs must not leave a __pycache__ in the worktree: the coordinator commits
# everything under spec/crypto-vectors/, and a .pyc is not part of the deliverable.
PYTHONDONTWRITEBYTECODE=1
export PYTHONDONTWRITEBYTECODE

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
venv=${CALFLEX_VECTOR_VENV:-"$HOME/.cache/flexcalendar-agent-team/e12-crypto-vectors-venv"}

if [ ! -x "$venv/bin/python" ]; then
  if ! command -v uv >/dev/null 2>&1; then
    echo "generate.sh needs uv (or set CALFLEX_VECTOR_VENV to an environment with the pinned deps)" >&2
    exit 1
  fi
  uv venv --python "${CALFLEX_VECTOR_PYTHON:-python3}" "$venv"
fi

if command -v uv >/dev/null 2>&1; then
  uv pip install --python "$venv/bin/python" --require-hashes -r "$here/requirements.txt" >/dev/null
fi

exec "$venv/bin/python" "$here/generate.py" "$@"
