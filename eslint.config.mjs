import js from '@eslint/js';
import globals from 'globals';

// --- E05-R02: exactly one module reaches CalDAV ------------------------------
//
// `server/api/src/caldav/adapter.mjs` is the only module that may import
// `tsdav`. The rule below is the automated half of that acceptance criterion;
// `server/api/test/caldav-imports.test.mjs` runs it through the real CLI and
// also checks that no other module under `server/api/src/` names the delegation
// header, the CalDAV origin variable or the delegation keys.
//
// `no-restricted-imports` covers static imports only, so a second rule covers
// `import('tsdav')` (ESLint 10.12's `no-restricted-imports` does not report
// dynamic imports). A computed specifier is out of reach of static analysis;
// that limit is asserted in the test rather than implied.
const CALDAV_ADAPTER = 'server/api/src/caldav/adapter.mjs';
const ONLY_ADAPTER_MESSAGE =
  'CalDAV is reached only through server/api/src/caldav/adapter.mjs (E05-R02).';
const tsdavStatic = () => [
  'error',
  {
    patterns: [
      { group: ['tsdav', 'tsdav/*', 'tsdav/**'], message: ONLY_ADAPTER_MESSAGE },
    ],
  },
];
const tsdavDynamic = () => [
  'error',
  {
    selector: 'ImportExpression[source.value=/^tsdav(\\/|$)/]',
    message: ONLY_ADAPTER_MESSAGE,
  },
];

export default [
  { ignores: ['**/node_modules/**', '**/vendor/**'] },
  js.configs.recommended,
  { files: ['**/*.mjs'], languageOptions: { globals: globals.node } },
  {
    files: ['**/*.{mjs,cjs,js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-imports': tsdavStatic(),
      'no-restricted-syntax': tsdavDynamic(),
    },
  },
  {
    // The one place both are allowed.
    files: [CALDAV_ADAPTER],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
