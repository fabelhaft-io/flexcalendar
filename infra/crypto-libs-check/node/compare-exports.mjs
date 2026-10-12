/**
 * E12-R02 crypto-libs probe — what the standard `libsodium-wrappers` build
 * lacks next to the sumo build.
 *
 * Run: `npm run exports` (or `node compare-exports.mjs`) from this directory.
 *
 * The epic's note ("the non-sumo build lacks `crypto_pwhash` and some other
 * primitives") is checked here rather than assumed: for the families E12-R02
 * cares about it prints a presence matrix, and it also reports the full
 * function-level set difference so the doc can say what "some other primitives"
 * is.
 */
import * as standard from 'libsodium-wrappers';
import * as sumo from 'libsodium-wrappers-sumo';

const standardSodium = standard.default ?? standard;
const sumoSodium = sumo.default ?? sumo;
await Promise.all([standardSodium.ready, sumoSodium.ready]);

const standardNames = new Set(Object.keys(standardSodium));
const sumoNames = new Set(Object.keys(sumoSodium));

const families = [
  'crypto_aead_xchacha20poly1305_ietf_',
  'crypto_box_',
  'crypto_sign',
  'crypto_kdf_',
  'crypto_kdf_hkdf_sha256_',
  'crypto_auth_hmacsha256',
  'crypto_pwhash',
  'randombytes_',
  'sodium_version',
];

console.log('node.version=' + process.version);
console.log('sodium.version_string.standard=' + standardSodium.sodium_version_string());
console.log('sodium.version_string.sumo=' + sumoSodium.sodium_version_string());
console.log('standard.exports=' + standardNames.size);
console.log('sumo.exports=' + sumoNames.size);

console.log('');
console.log('# presence per family (function = callable, constant = value only)');
const kind = (names, sodium, name) =>
  names.has(name)
    ? typeof sodium[name] === 'function'
      ? 'function'
      : 'constant'
    : 'absent';
for (const family of families) {
  const names = [...sumoNames]
    .filter((name) => name.startsWith(family))
    .sort();
  for (const name of names) {
    console.log(
      `${name}\tstandard=${kind(standardNames, standardSodium, name)}\tsumo=${kind(sumoNames, sumoSodium, name)}`,
    );
  }
}

const onlyInStandard = [...standardNames]
  .filter((name) => !sumoNames.has(name))
  .sort();
const onlyInSumoFunctions = [...sumoNames]
  .filter((name) => !standardNames.has(name))
  .filter((name) => typeof sumoSodium[name] === 'function')
  .sort();

console.log('');
console.log('# set difference');
console.log('only_in_standard=' + (onlyInStandard.join(',') || 'none'));
console.log('only_in_sumo.functions=' + onlyInSumoFunctions.length);
const byPrefix = new Map();
for (const name of onlyInSumoFunctions) {
  // Group by the API family, e.g. crypto_pwhash_argon2id_* -> crypto_pwhash
  const prefix = name.split('_').slice(0, 2).join('_');
  byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
}
for (const [prefix, count] of [...byPrefix].sort()) {
  console.log(`only_in_sumo.function_family.${prefix}=${count}`);
}
