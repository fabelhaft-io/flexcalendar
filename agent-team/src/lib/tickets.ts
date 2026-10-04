import fs from 'node:fs';
import path from 'node:path';

export interface Ticket {
  id: string;
  heading: string;
  body: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds a `### [TICKET-<id>] ...` section in FEATURES.md and returns everything up to
 * (not including) the next `##`/`###` heading. `ticketId` is developer-supplied CLI
 * input, not attacker-controlled, but it's still escaped before going into a RegExp.
 */
export function findTicket(repoRoot: string, ticketId: string): Ticket {
  const featuresPath = path.join(repoRoot, 'FEATURES.md');
  const text = fs.readFileSync(featuresPath, 'utf8');

  const headingRe = new RegExp(`^###\\s*\\[TICKET-${escapeRegExp(ticketId)}\\].*$`, 'm');
  const match = headingRe.exec(text);
  if (!match) {
    throw new Error(
      `No "[TICKET-${ticketId}]" heading found in FEATURES.md. Check the ticket ID and try again.`,
    );
  }

  const bodyStart = match.index + match[0].length;
  const rest = text.slice(bodyStart);
  const nextHeadingRe = /^##+\s/m;
  const nextHeadingMatch = nextHeadingRe.exec(rest);
  const body = (nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest).trim();

  return {
    id: ticketId,
    heading: match[0].replace(/^###\s*/, ''),
    body,
  };
}
