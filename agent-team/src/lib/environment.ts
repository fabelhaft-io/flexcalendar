import { spawnSync } from 'node:child_process';
import { ensureToolchains } from './toolchains.js';

// Computed once per coordinator run (PATH checks and `--version` calls on the host, no LLM call)
// and handed to every agent as a fact block in its system prompt, so "is there PHP, can I run
// podman" isn't rediscovered with a dozen tool calls on every run.

function version(bin: string, args: string[] = ['--version']): string | null {
  // spawnSync rather than execFileSync: `java -version` prints to stderr and exits 0.
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout}\n${r.stderr}`.split('\n').find((l) => l.trim())?.trim() ?? '';
}

export interface EnvironmentFacts {
  node: string;
  corepack: string | null;
  java: string | null;
  plantuml: string | null;
  podman: string | null;
  php: string | null;
  composer: string | null;
  flutter: string | null;
  make: string | null;
}

export function probeEnvironment(): EnvironmentFacts {
  // PHP and Composer are the sandbox's pinned toolchains, not whatever the host has.
  const tools = ensureToolchains();
  return {
    node: process.version,
    corepack: version('corepack'),
    java: version('java', ['-version']),
    plantuml: version('plantuml', ['-version']),
    podman: version('podman'),
    php: tools ? version(tools.php, ['-v']) : null,
    composer: tools ? version(tools.composer) : null,
    flutter: version('flutter'),
    make: version('make'),
  };
}

export function formatEnvironmentFacts(facts: EnvironmentFacts): string {
  const or = (v: string | null, missing: string) => v ?? missing;
  const lines = [
    `Node: ${facts.node} (nvm install, mounted read-only). npm is available.`,
    `corepack: ${or(facts.corepack, 'not found')}. pnpm is NOT on PATH: run it as \`corepack pnpm <args>\` ` +
      '(`corepack enable` would need to write into the read-only Node install). Its download is cached ' +
      'across runs in the sandbox cache, so the first call may take a few seconds and later ones are fast.',
    `Java: ${or(facts.java, 'not found')}. Gradle wrappers download into a cached GRADLE_USER_HOME.`,
    `plantuml: ${or(facts.plantuml, 'not found')}.`,
    `make: ${or(facts.make, 'not found')}.`,
    facts.php && facts.composer
      ? `PHP: ${facts.php}, a static build with pdo_pgsql, mbstring, tokenizer, dom, xml, zip and openssl. ` +
        `Composer: ${facts.composer}. Both are on PATH (\`php\`, \`composer\`), pinned and read-only. ` +
        'Run `composer install` in server/caldav before its scripts; its cache persists across runs. ' +
        'Keep composer.lock in step with composer.json; the coordinator commits it with your other changes.'
      : 'PHP and Composer: NOT available in this run (the coordinator could not provision them). ' +
        'Write PHP carefully, and list every PHP check you could not run under openQuestions.',
    `Podman: ${or(facts.podman, 'not found')} on the host, but NOT usable from your sandbox: rootless podman ` +
      'cannot start under bwrap, and the Podman socket is deliberately not mounted. Do not try `podman`, ' +
      '`podman compose`, `docker` or `make dev`. Anything that needs the local stack (integration tests, ' +
      '`make dev`, `make verify`) is run by the human-side reviewer outside the sandbox; say which commands ' +
      'they should run in openQuestions.',
    `Flutter/Dart: ${or(facts.flutter, 'not installed on this machine')}.`,
    'Network: available (package registries work). SSH, the production server and DNS are off-limits.',
  ];
  return [
    'Known environment (computed by the coordinator moments before you started — trust it; only ' +
      're-verify with one targeted check if a decision critically depends on it. Do not re-derive it ' +
      'with a broad sweep.):',
    ...lines.map((l) => `- ${l}`),
  ].join('\n');
}
