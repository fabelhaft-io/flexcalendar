// Podman 4.9 splits exec-form health-check arguments at whitespace, even when
// Compose/YAML preserved them as one string. Do not include argument contents
// in diagnostics: a future probe might contain credentials.
/** @param {unknown} test */
export function portableExecHealthcheck(test) {
  return (
    !Array.isArray(test) ||
    test[0] !== 'CMD' ||
    test
      .slice(1)
      .every((argument) => typeof argument === 'string' && !/\s/.test(argument))
  );
}
