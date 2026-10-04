// Tool-call-by-tool-call progress logging for a running agent, so a foreground `npm run
// dev-team` shows what's happening instead of going silent for minutes (agent.generate()'s
// non-streaming call was exactly that silence — see the "log stays blank" note this replaces
// in docs/architecture/agent-dev-team.md). Deliberately terse: one line per tool call/result,
// nothing for token-level text deltas or step boundaries, since those are pure noise for a
// coding agent that mostly just calls tools.

interface StreamChunk {
  type: string;
  payload?: unknown;
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  if (typeof record.path === 'string') return record.path;
  if (typeof record.command === 'string') return record.command;
  const json = JSON.stringify(record);
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

function describeChunk(chunk: StreamChunk): string | null {
  const payload = (chunk.payload ?? {}) as Record<string, unknown>;
  switch (chunk.type) {
    case 'tool-call':
      return `→ ${payload.toolName}(${summarizeArgs(payload.args)})`;
    case 'tool-result':
      return `✓ ${payload.toolName}${payload.isError ? ' [error]' : ''}`;
    case 'tool-error':
      return `✗ ${payload.toolName} failed: ${String(payload.error)}`;
    case 'finish':
      return '(turn complete)';
    default:
      return null;
  }
}

/**
 * Drains a Mastra `MastraModelOutput`'s `fullStream`, logging one line per tool call/result
 * as it happens. Does not touch `.object` — call that separately after this resolves to get
 * the schema-validated structured handoff (draining fullStream is what lets it resolve).
 */
export async function logAgentProgress(
  label: string,
  output: { fullStream: AsyncIterable<StreamChunk> },
): Promise<void> {
  for await (const chunk of output.fullStream) {
    const line = describeChunk(chunk);
    if (line) console.log(`[${label}] ${line}`);
  }
}
