# Corpus check registrations

No checks are registered yet (E15-R01). Add a named `.json` file containing a
nonempty array of command argument arrays. Commands run from the repository root,
in filename order, against the already running local stack, and must exit nonzero
on failure. `make verify-corpus` executes this registry. Never log event content,
including fixture content, or envelope bytes.
