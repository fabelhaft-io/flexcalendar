import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_PROVIDER_PREFIXES = ['anthropic/', 'openai/', 'deepseek/'] as const;

const REQUIRED_ENV_VAR_BY_PROVIDER: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

function resolveModel(roleEnvVar: string): string {
  const value = process.env[roleEnvVar] ?? process.env.AGENT_MODEL;
  if (!value) {
    throw new Error(
      `${roleEnvVar} (or the AGENT_MODEL fallback) is not set. Set it to a Mastra model-router ` +
        `id such as "anthropic/claude-sonnet-5" — see agent-team/.env.example. This orchestrator ` +
        `does not default to a model silently.`,
    );
  }
  if (!ALLOWED_PROVIDER_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    throw new Error(
      `${roleEnvVar}="${value}" has a provider prefix outside the allowed list ` +
        `(${ALLOWED_PROVIDER_PREFIXES.join(', ')}). Add the provider to ` +
        `ALLOWED_PROVIDER_PREFIXES in agent-team/src/config.ts once it's actually wired up.`,
    );
  }
  const provider = value.split('/')[0];
  const requiredEnvVar = REQUIRED_ENV_VAR_BY_PROVIDER[provider];
  if (requiredEnvVar && !process.env[requiredEnvVar]) {
    throw new Error(`${roleEnvVar}="${value}" needs ${requiredEnvVar} to be set.`);
  }
  return value;
}

export interface AgentTeamConfig {
  repoRoot: string;
  baseBranch: string;
  frontendModel: string;
  backendModel: string;
  reviewerModel: string;
}

export function loadConfig(): AgentTeamConfig {
  return {
    repoRoot: process.env.REPO_ROOT ?? path.resolve(__dirname, '..', '..'),
    // Defaults to `main`, which is correct once this orchestrator has landed there.
    // Override for a dry run against a branch that hasn't merged yet.
    baseBranch: process.env.BASE_BRANCH ?? 'main',
    frontendModel: resolveModel('AGENT_MODEL_FRONTEND'),
    backendModel: resolveModel('AGENT_MODEL_BACKEND'),
    reviewerModel: resolveModel('AGENT_MODEL_REVIEWER'),
  };
}
