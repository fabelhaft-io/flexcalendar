# Invariant check registrations

No checks are registered yet (E02-R05). Add a named `.json` file containing a
nonempty array of command argument arrays, for example:

```json
[["node", "infra/scripts/check-uuid.mjs"]]
```

Checks run from the repository root, in filename order, inherit the local stack
environment, and must exit nonzero on failure. Do not put secrets or event content
in registrations or output. `make verify-invariants` executes this registry.
