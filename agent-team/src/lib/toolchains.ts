import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pinned toolchains the host doesn't have but the implementer needs inside the sandbox. They are
// downloaded once, checked against the SHA-256 below, kept in a directory of their own and bound
// read-only into every sandbox, so an agent can neither change nor replace them between runs.
//
// PHP: a statically linked CLI from static-php-cli's "common" bundle (https://static-php.dev).
// The official php images link against Debian's libraries and don't run on an arbitrary host.
// The bundle carries every extension server/caldav's tooling needs, pdo_pgsql included, so
// Composer's platform check passes without --ignore-platform-req. static-php.dev publishes no
// checksums, so the hashes are the ones recorded when the build was first downloaded and run.
// 8.4.23 is the newest 8.4 build there (php.net was at 8.4.26 on 2026-10-05). The sandbox only
// runs format, lint, static analysis and unit tests; the service image uses the official
// php:8.4 base. Bump the version when static-php.dev publishes a newer one.
//
// Composer: the official composer.phar, whose hash getcomposer.org publishes next to each
// release (`<url>.sha256sum`).
const PHP = {
  version: '8.4.23',
  url: 'https://dl.static-php.dev/static-php-cli/common/php-8.4.23-cli-linux-x86_64.tar.gz',
  archiveSha256: '1aeed5bc7967977ca5b1da7163acd91bf9ba3ac56037045d4e91ee2ff2712bb7',
  binarySha256: '7beff96849c29471d25d516087cfbd3ae9d133c90a1e986d2e60c63eb0800bb6',
};
const COMPOSER = {
  version: '2.10.3',
  url: 'https://getcomposer.org/download/2.10.3/composer.phar',
  sha256: '7a2d379d5b8ffdaa028580ef26494c36d2feef4b178d3dd1473a4dbc5e17c8d6',
};

export interface Toolchains {
  /** Bound read-only into the sandbox. */
  root: string;
  /** Put on the sandbox's PATH: `php` and `composer`. */
  binDir: string;
  php: string;
  composer: string;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hasHash(file: string, expected: string): boolean {
  return fs.existsSync(file) && sha256(file) === expected;
}

export function download(url: string, dest: string, timeoutMs = 5 * 60 * 1000): void {
  const r = spawnSync('curl', ['--fail', '--silent', '--show-error', '--location', '--output', dest, url], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (r.error || r.status !== 0) throw new Error(`download of ${url} failed: ${r.error?.message ?? r.stderr.trim()}`);
}

export function verified(file: string, expected: string, what: string): void {
  const actual = sha256(file);
  if (actual !== expected) throw new Error(`${what}: SHA-256 ${actual}, expected ${expected}; refusing to use it`);
}

function provision(root: string): void {
  const staging = fs.mkdtempSync(path.join(root, '.staging-'));
  try {
    const archive = path.join(staging, 'php.tar.gz');
    download(PHP.url, archive);
    verified(archive, PHP.archiveSha256, `PHP ${PHP.version} archive`);
    const tar = spawnSync('tar', ['-xzf', archive, '-C', staging, 'php'], { encoding: 'utf8' });
    if (tar.error || tar.status !== 0) throw new Error(`unpacking PHP failed: ${tar.error?.message ?? tar.stderr.trim()}`);
    verified(path.join(staging, 'php'), PHP.binarySha256, `PHP ${PHP.version} binary`);

    const phar = path.join(staging, 'composer.phar');
    download(COMPOSER.url, phar);
    verified(phar, COMPOSER.sha256, `Composer ${COMPOSER.version}`);

    const bin = path.join(staging, 'bin');
    fs.mkdirSync(bin);
    fs.copyFileSync(path.join(staging, 'php'), path.join(bin, 'php'));
    fs.chmodSync(path.join(bin, 'php'), 0o555);
    fs.copyFileSync(phar, path.join(bin, 'composer.phar'));
    fs.chmodSync(path.join(bin, 'composer.phar'), 0o444);
    // A wrapper rather than an executable phar, so `composer` runs on this PHP and no other.
    fs.writeFileSync(path.join(bin, 'composer'), '#!/bin/sh\nexec "$(dirname "$0")/php" "$(dirname "$0")/composer.phar" "$@"\n', {
      mode: 0o555,
    });

    const target = path.join(root, toolchainDirName());
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(bin, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function toolchainDirName(): string {
  return `php-${PHP.version}-composer-${COMPOSER.version}`;
}

let cached: Toolchains | null | undefined;

/**
 * Returns the sandbox toolchains, downloading and verifying them on first use. Every call
 * re-checks the hashes, because the directory sits on the host disk. Returns null (and the
 * caller reports PHP as unavailable) when they can't be provisioned, for example offline, so a
 * requirement that needs no PHP still runs.
 */
export function ensureToolchains(): Toolchains | null {
  if (cached !== undefined) return cached;
  const root = path.join(os.homedir(), '.cache', 'calendar-flex-agent-team-tools');
  const binDir = path.join(root, toolchainDirName());
  const php = path.join(binDir, 'php');
  const composerPhar = path.join(binDir, 'composer.phar');
  try {
    fs.mkdirSync(root, { recursive: true });
    if (!hasHash(php, PHP.binarySha256) || !hasHash(composerPhar, COMPOSER.sha256)) provision(root);
    verified(php, PHP.binarySha256, `PHP ${PHP.version} binary`);
    verified(composerPhar, COMPOSER.sha256, `Composer ${COMPOSER.version}`);
    cached = { root, binDir, php, composer: path.join(binDir, 'composer') };
  } catch (error) {
    console.warn(`[toolchains] PHP and Composer are unavailable in the sandbox: ${(error as Error).message}`);
    cached = null;
  }
  return cached;
}
