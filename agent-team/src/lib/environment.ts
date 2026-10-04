import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Computed once per coordinator run (plain filesystem/PATH checks, no LLM call) and handed to
// every agent as a fact block in its system prompt — this is what stops "is there an Android
// SDK, is Maestro installed, is there network to Google's repo" from being rediscovered via a
// dozen tool calls on every single run. See docs/architecture/agent-dev-team.md's "Known
// environment" section for the rationale and the staleness tradeoff.

function commandExists(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function findAndroidSdkRoot(): string | null {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter((p): p is string => !!p);
  return candidates.find(exists) ?? null;
}

function findAvds(): string[] {
  const avdDir = path.join(os.homedir(), '.android', 'avd');
  return safeReaddir(avdDir).filter((name) => name.endsWith('.avd'));
}

function hasSdkManager(androidSdkRoot: string | null): boolean {
  if (!androidSdkRoot) return false;
  const cmdlineToolsDir = path.join(androidSdkRoot, 'cmdline-tools');
  return safeReaddir(cmdlineToolsDir).some((dir) =>
    exists(path.join(cmdlineToolsDir, dir, 'bin', 'sdkmanager')),
  );
}

export interface EnvironmentFacts {
  androidSdkRoot: string | null;
  hasAdb: boolean;
  hasEmulatorBinary: boolean;
  avds: string[];
  hasSdkManager: boolean;
  hasMaestro: boolean;
  hasJava: boolean;
  hasDocker: boolean;
}

export function probeEnvironment(): EnvironmentFacts {
  const androidSdkRoot = findAndroidSdkRoot();
  return {
    androidSdkRoot,
    hasAdb: !!androidSdkRoot && exists(path.join(androidSdkRoot, 'platform-tools', 'adb')),
    hasEmulatorBinary: !!androidSdkRoot && exists(path.join(androidSdkRoot, 'emulator', 'emulator')),
    avds: findAvds(),
    hasSdkManager: hasSdkManager(androidSdkRoot),
    hasMaestro: commandExists('maestro') || exists(path.join(os.homedir(), '.maestro', 'bin', 'maestro')),
    hasJava: commandExists('java'),
    hasDocker: commandExists('docker'),
  };
}

export function formatEnvironmentFacts(facts: EnvironmentFacts): string {
  const lines = [
    `Android SDK root: ${facts.androidSdkRoot ?? 'not found'}`,
    `adb binary: ${facts.hasAdb ? 'present' : 'not found'}`,
    `emulator binary: ${facts.hasEmulatorBinary ? 'present' : 'not found'}`,
    `Configured AVDs: ${facts.avds.length ? facts.avds.join(', ') : 'none'}`,
    `sdkmanager (only needed to install a *new* platform/system image): ${facts.hasSdkManager ? 'present' : 'not found'}`,
    `Maestro CLI: ${facts.hasMaestro ? 'present' : 'not found'}`,
    `Java: ${facts.hasJava ? 'present' : 'not found — required to run the Android emulator/tooling'}`,
    `Docker: ${facts.hasDocker ? 'present' : 'not found'}`,
    // ANDROID_HOME/ANDROID_SDK_ROOT are frequently unset even when the SDK is installed at the
    // default location (~/Android/Sdk) — androidSdkRoot above already accounts for that, but a
    // script invoked without the env var set still needs to export it or pass an explicit path.
  ];
  return [
    'Known environment (computed once by the coordinator via direct filesystem/PATH checks ' +
      'before you started — not a guess, but a point-in-time snapshot taken moments ago. Trust ' +
      'it; only re-verify with one targeted check if a decision critically depends on something ' +
      "here, since it can go stale between runs. Don't re-derive this with a broad sweep.):",
    ...lines.map((l) => `- ${l}`),
  ].join('\n');
}
