import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalSandbox } from '@mastra/core/workspace';
import { ensureToolchains, type Toolchains } from './toolchains.js';

// OS-level shell hardening. LocalFilesystem containment only covers the file *tools*; a shell
// command via execute_command could otherwise reach anywhere on the host (that is how a run in
// the harness this was copied from committed edits to its own agent definitions).
// `isolation: 'bwrap'` closes that: writes outside the allowed paths never reach the real
// filesystem, even though the shell command reports success (bwrap gives the sandboxed process
// its own ephemeral view — verified by writing a file, seeing exit 0, and confirming on the
// real host disk the file never existed).
//
// Mirrors @mastra/core's internal buildBwrapCommand default construction (see
// node_modules/@mastra/core/dist/workspace-*.js) plus two fixes Mastra's own builder is
// missing, found by testing against a real project rather than trusting the docs:
//   1. No /dev at all by default — breaks anything that touches /dev/null, which is most
//      tools (git chief among them: "could not open '/dev/null' for reading and writing").
//   2. `allowSystemBinaries` only binds process.execPath's own bin/ directory. Under a version
//      manager (nvm, volta, asdf, ...) npm is a symlink from bin/ into a sibling
//      lib/node_modules/npm/, which isn't visible unless the whole version directory is bound.
//
// Passing `bwrapArgs` to LocalSandbox REPLACES Mastra's whole default construction rather than
// extending it (see buildBwrapCommand: `if (config.bwrapArgs?.length) return only those args`),
// so this has to duplicate the default faithfully rather than layer on top of it. Revisit/
// delete this the day @mastra/core's bwrap builder handles /dev and version-manager installs
// itself.
const DEFAULT_READONLY_BINDS = [
  '/usr',
  '/lib',
  '/lib64',
  '/bin',
  '/sbin',
  '/etc/alternatives',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/passwd',
  '/etc/group',
  '/etc/nsswitch.conf',
  '/etc/ld.so.cache',
  '/etc/localtime',
];

function buildBwrapArgsWithDev(opts: {
  workspacePath: string;
  readOnlyPaths?: string[];
  readWritePaths?: string[];
  allowNetwork?: boolean;
}): string[] {
  const args: string[] = ['--unshare-pid', '--unshare-ipc', '--unshare-uts'];
  if (!opts.allowNetwork) args.push('--unshare-net');
  args.push('--proc', '/proc');
  args.push('--tmpfs', '/tmp');
  args.push('--dev-bind', '/dev', '/dev');
  for (const p of DEFAULT_READONLY_BINDS) args.push('--ro-bind-try', p, p);
  const nodeVersionDir = path.dirname(path.dirname(process.execPath));
  if (!DEFAULT_READONLY_BINDS.some((p) => nodeVersionDir.startsWith(p))) {
    args.push('--ro-bind', nodeVersionDir, nodeVersionDir);
  }
  args.push('--ro-bind-try', '/opt', '/opt');
  args.push('--ro-bind-try', '/snap', '/snap');
  args.push('--bind', opts.workspacePath, opts.workspacePath);
  for (const p of opts.readWritePaths ?? []) args.push('--bind', p, p);
  // Read-only binds go last so they shadow anything the read-write binds above exposed (the
  // worktree's own `.git` pointer file sits inside the read-write workspace bind).
  for (const p of opts.readOnlyPaths ?? []) args.push('--ro-bind', p, p);
  args.push('--chdir', opts.workspacePath);
  args.push('--die-with-parent');
  return args;
}

/**
 * Persistent, agent-only cache directory, bound read-write into every sandbox so corepack,
 * pnpm, npm, Composer and Gradle stop re-downloading on every run. It is deliberately NOT the user's real
 * `~/.cache`: nothing the sandbox writes here can touch host tool state. The sandbox's `HOME`
 * points inside it too, because bwrap gives the process no home directory of its own.
 */
export function agentCacheDir(): string {
  const dir = path.join(os.homedir(), '.cache', 'calendar-flex-agent-team');
  for (const sub of ['home', 'corepack', 'pnpm-store', 'npm', 'xdg', 'gradle', 'composer']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

/**
 * The sandbox's whole environment. Mastra passes only what is listed here, so API keys from
 * agent-team/.env and the user's shell never reach agent commands. pnpm is reached through
 * `corepack pnpm …`, because `corepack enable` would have to write into the (read-only) Node
 * install. PHP and Composer come from the pinned, read-only toolchain directory (`toolchains.ts`).
 */
function sandboxEnv(cacheDir: string, tools: Toolchains | null): NodeJS.ProcessEnv {
  const toolPath = tools ? [tools.binDir] : [];
  return {
    PATH: [path.dirname(process.execPath), ...toolPath, '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: path.join(cacheDir, 'home'),
    LANG: 'C.UTF-8',
    COREPACK_HOME: path.join(cacheDir, 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_cache: path.join(cacheDir, 'npm'),
    npm_config_store_dir: path.join(cacheDir, 'pnpm-store'),
    XDG_CACHE_HOME: path.join(cacheDir, 'xdg'),
    GRADLE_USER_HOME: path.join(cacheDir, 'gradle'),
    COMPOSER_HOME: path.join(cacheDir, 'composer'),
    COMPOSER_CACHE_DIR: path.join(cacheDir, 'composer', 'cache'),
    COMPOSER_NO_INTERACTION: '1',
  };
}

/**
 * Hard per-command limit, enforced by `enforceCommandTimeout`. `LocalSandbox` declares a
 * `timeout` option documented as "default: 30000", but @mastra/core 1.64 never reads it: the only
 * timeout is the optional `timeout` the model passes to `execute_command`, so without this a
 * command the model starts without one (a hung server, a prompt waiting on stdin) never ends.
 */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Applies `limitMs` to every command the sandbox runs: as the default when the model passes no
 * timeout, and as a cap when it passes a longer one (or 0, which Mastra treats as "none").
 * Wraps the process manager's `spawn`, which both paths go through: the foreground
 * `executeCommand` Mastra installs on the sandbox, and background `processes.spawn`.
 */
export function enforceCommandTimeout(sandbox: LocalSandbox, limitMs = COMMAND_TIMEOUT_MS): LocalSandbox {
  const pm = sandbox.processes;
  if (!pm) throw new Error('LocalSandbox has no process manager; cannot enforce the command timeout.');
  const spawn = pm.spawn.bind(pm);
  pm.spawn = (command, options = {}) => {
    const requested = options.timeout;
    const timeout = requested && requested > 0 ? Math.min(requested, limitMs) : limitMs;
    return spawn(command, { ...options, timeout });
  };
  return sandbox;
}

let loggedFallback = false;

/**
 * Builds a `LocalSandbox` for one agent, hardened when possible. Falls back to no isolation on
 * anything other than Linux+bwrap — seatbelt (macOS) hasn't been tested and shouldn't be
 * silently assumed safe.
 *
 * What is NOT bound, on purpose: `/run/user/<uid>` (the Podman socket — a sandbox escape; and a
 * failed rootless-podman attempt through a read-write bind once deleted the host's `pause.pid`),
 * the user's home directory, and anything outside the worktree except the paths below. The
 * pinned PHP/Composer directory is bound read-only, after the read-write binds.
 * Rootless `podman` itself cannot run under bwrap ("Error determining cgroups mode"), so
 * stack-dependent checks run outside the sandbox, during review.
 */
export function hardenedSandbox(opts: {
  workspacePath: string;
  readOnlyPaths?: string[];
  allowNetwork?: boolean;
}): LocalSandbox {
  const cacheDir = agentCacheDir();
  const tools = ensureToolchains();
  const env = sandboxEnv(cacheDir, tools);
  const detection = LocalSandbox.detectIsolation();
  if (os.platform() !== 'linux' || detection.backend !== 'bwrap' || !detection.available) {
    if (!loggedFallback) {
      loggedFallback = true;
      console.warn(
        `[sandbox] No verified OS-level isolation available on this platform (${detection.backend}, ` +
          `available=${detection.available}) — shell commands are unrestricted. See ` +
          `agent-team/src/lib/sandbox.ts.`,
      );
    }
    return enforceCommandTimeout(new LocalSandbox({ workingDirectory: opts.workspacePath, env }));
  }
  return enforceCommandTimeout(new LocalSandbox({
    workingDirectory: opts.workspacePath,
    env,
    isolation: 'bwrap',
    nativeSandbox: {
      bwrapArgs: buildBwrapArgsWithDev({
        workspacePath: opts.workspacePath,
        allowNetwork: opts.allowNetwork ?? true,
        readOnlyPaths: [...(tools ? [tools.root] : []), ...(opts.readOnlyPaths ?? [])],
        readWritePaths: [cacheDir],
      }),
    },
  }));
}
