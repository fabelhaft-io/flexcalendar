/**
 * E12-R02 crypto-libs probe — the **web** library, sumo build.
 *
 * Run: `npm run probe:sumo` (or `node probe-sumo.mjs`) from this directory.
 *
 * The epic's note says the standard `libsodium-wrappers` build lacks some
 * primitives, so the sumo build is run through exactly the same checks. The two
 * outputs are what `docs/verification/crypto-libs-2026-10-12.md` compares to
 * decide which build `packages/crypto-ts` (E12-R03) should depend on.
 */
import { frozenValueMismatches, runChecks } from './lib/checks.mjs';

const module = await import('libsodium-wrappers-sumo');
const sodium = module.default ?? module;
await sodium.ready;

const packageVersion = '0.8.4';

const report = await runChecks(sodium, {
  libraryName: 'libsodium-wrappers-sumo',
  packageVersion,
  implementation: 'sodium.js (bundled libsodium, sumo build)',
});
const mismatches = frozenValueMismatches(report);

console.log(
  `# E12-R02 crypto-libs probe — libsodium-wrappers-sumo ${packageVersion}`,
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
