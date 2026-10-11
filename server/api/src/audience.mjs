// --- E05-R01: the audience an access token must carry ------------------------
//
// The expected `aud` is Zitadel's project ID, which OpenTofu creates at
// `make seed` and which is therefore unknown when the API container boots.
// `CALFLEX_OIDC_AUDIENCE` wins when it is set; otherwise the trimmed first line
// of the file CALFLEX_OIDC_AUDIENCE_FILE is read, lazily, and read again after
// an audience mismatch (at most once per window). Locally the file is written
// by `zitadel-config apply` into the shared `oidc-config` volume.
//
// While neither is available every request is refused with 503: an API that
// cannot validate anyone must never accept anyone.

import { readFile } from 'node:fs/promises';

/** How often the file may be re-read while it is missing or after a mismatch. */
export const AUDIENCE_WINDOW_MS = 5000;

/**
 * @param {object} options
 * @param {string} [options.audience] explicit value, wins over the file
 * @param {string} [options.file] path to the file `apply` writes
 * @param {() => number} [options.now] clock, injectable for tests
 * @param {(path: string, encoding: 'utf8') => Promise<string>} [options.read] file reader
 */
export function createAudienceSource({
  audience,
  file,
  now = Date.now,
  read = readFile,
} = {}) {
  const fixed = audience || undefined;
  /** @type {string | undefined} */
  let cached = fixed;
  let lastRead = Number.NEGATIVE_INFINITY;
  let lastRefresh = Number.NEGATIVE_INFINITY;

  /** @returns {Promise<string | undefined>} */
  async function fromFile() {
    if (!file) return undefined;
    try {
      const line = String(await read(file, 'utf8'))
        .split('\n')[0]
        .trim();
      return line || undefined;
    } catch {
      // A missing file is the normal state before `make seed`, never an error.
      return undefined;
    }
  }

  return {
    /**
     * The audience to validate against right now, or undefined while the stack
     * has not written one yet.
     * @returns {Promise<string | undefined>}
     */
    async current() {
      if (cached !== undefined) return cached;
      if (!file) return undefined;
      if (now() - lastRead < AUDIENCE_WINDOW_MS) return undefined;
      lastRead = now();
      cached = await fromFile();
      return cached;
    },
    /**
     * Re-reads the file after a token failed on audience. Returns false when
     * there is nothing to re-read or the window has not passed, so a flood of
     * bad tokens cannot become a flood of file reads.
     * @returns {Promise<boolean>}
     */
    async refresh() {
      if (fixed !== undefined || !file) return false;
      if (now() - lastRefresh < AUDIENCE_WINDOW_MS) return false;
      lastRefresh = now();
      cached = await fromFile();
      return true;
    },
  };
}
