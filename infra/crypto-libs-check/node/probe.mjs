/**
 * E12-R02 crypto-libs probe — the **web** library, standard build.
 *
 * Run: `npm run probe` (or `node probe.mjs`) from this directory.
 *
 * Loads `libsodium-wrappers` (sodium.js, the build ADR 0001 § Private calendars
 * names for the web client) and runs every primitive check on it. See
 * `lib/checks.mjs` for the checks and `../README.md` for how to read the output.
 */
import { frozenValueMismatches, runChecks } from './lib/checks.mjs';

const module = await import('libsodium-wrappers');
const sodium = module.default ?? module;
await sodium.ready;

const packageVersion = '0.8.4';

const report = await runChecks(sodium, {
  libraryName: 'libsodium-wrappers',
  packageVersion,
  implementation:
    'sodium.js (bundled libsodium, standard build — the sumo build is probe-sumo.mjs)',
});
const mismatches = frozenValueMismatches(report);

console.log(
  `# E12-R02 crypto-libs probe — libsodium-wrappers ${packageVersion} (standard)`,
);
console.log(`node.version=${process.version}`);
for (const line of report.lines) console.log(line);
for (const gap of report.gaps) console.log(`gap: ${gap}`);
console.log(`frozen_values=${mismatches.length === 0 ? 'match' : 'MISMATCH'}`);
for (const mismatch of mismatches) {
  console.error(`FAIL frozen value ${mismatch}`);
}
for (const failure of report.failures) console.error(`FAIL ${failure}`);

process.exit(
  report.failures.length === 0 && mismatches.length === 0 ? 0 : 1,
);
