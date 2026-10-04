import fs from 'node:fs';
import path from 'node:path';

export interface Requirement {
  /** e.g. `E02-R01` */
  id: string;
  /** e.g. `E02` */
  epicId: string;
  /** The heading text without the leading `### `, e.g. "E02-R01 · Repository layout   `agent`". */
  heading: string;
  /** The requirement title only, e.g. "Repository layout". */
  title: string;
  /** Executor tag from the heading: `agent`, `agent+review` or `human`. */
  executor: string;
  /** Everything under the heading up to (not including) the next heading. */
  body: string;
  /** Repo-relative path of the epic file. */
  epicPath: string;
  /** The epic's title line, header table and `## Goal` section (plus `## Out of scope` if present). */
  epicContext: string;
  /** The epic header table's `Spec` cell, verbatim. */
  specRow: string;
  /** The epic header table's `Status` cell, verbatim. */
  epicStatus: string;
}

const REQUIREMENT_ID_RE = /^E\d{2}-R\d{2}$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns the text of `## <name>` up to the next `##` heading, or null. */
export function extractH2Section(text: string, name: string): string | null {
  const re = new RegExp(`^##\\s+${escapeRegExp(name)}.*$`, 'm');
  const match = re.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = /^##\s/m.exec(rest);
  return `${match[0]}${next ? rest.slice(0, next.index) : rest}`.trim();
}

function headerTableCell(epicText: string, label: string): string {
  const re = new RegExp(`^\\|\\s*${escapeRegExp(label)}\\s*\\|(.*)\\|\\s*$`, 'm');
  return re.exec(epicText)?.[1].trim() ?? '';
}

/**
 * Finds `### <ID> · …` in `docs/epics/E<nn>-*.md`. `id` is operator-supplied CLI input, but it
 * is still validated and escaped before it reaches a RegExp.
 */
export function findRequirement(repoRoot: string, id: string): Requirement {
  if (!REQUIREMENT_ID_RE.test(id)) {
    throw new Error(`"${id}" is not a requirement ID; expected something like E02-R01.`);
  }
  const epicId = id.slice(0, 3);
  const epicsDir = path.join(repoRoot, 'docs', 'epics');
  const epicFile = fs.readdirSync(epicsDir).find((f) => f.startsWith(`${epicId}-`) && f.endsWith('.md'));
  if (!epicFile) throw new Error(`No epic file for ${epicId} in docs/epics/.`);
  const epicText = fs.readFileSync(path.join(epicsDir, epicFile), 'utf8');

  const headingRe = new RegExp(`^###\\s+${escapeRegExp(id)}\\s+·.*$`, 'm');
  const match = headingRe.exec(epicText);
  if (!match) throw new Error(`No "### ${id} · …" heading in docs/epics/${epicFile}.`);

  const rest = epicText.slice(match.index + match[0].length);
  const next = /^##+\s/m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();

  const heading = match[0].replace(/^###\s+/, '');
  // "E08-R04 · Backups from day one   `agent` + `human`": title before the first tag, every tag kept.
  const afterDot = heading.slice(heading.indexOf('·') + 1);
  const firstTick = afterDot.indexOf('`');
  const title = (firstTick === -1 ? afterDot : afterDot.slice(0, firstTick)).trim();
  const executor = [...afterDot.matchAll(/`([^`]+)`/g)].map((m) => m[1]).join(' + ') || 'unknown';

  const firstH2 = /^##\s/m.exec(epicText);
  const header = (firstH2 ? epicText.slice(0, firstH2.index) : epicText).trim();
  const epicContext = [header, extractH2Section(epicText, 'Goal'), extractH2Section(epicText, 'Out of scope')]
    .filter(Boolean)
    .join('\n\n');

  return {
    id,
    epicId,
    heading,
    title,
    executor,
    body,
    epicPath: path.posix.join('docs', 'epics', epicFile),
    epicContext,
    specRow: headerTableCell(epicText, 'Spec'),
    epicStatus: headerTableCell(epicText, 'Status'),
  };
}

/** `feat/<ID>-<slug>`, per the `06` working agreement. */
export function branchSlug(requirement: Requirement): string {
  const slug = requirement.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${requirement.id}-${slug}`;
}

/**
 * Resolves the docs an epic's Spec row names: `01-architecture.md`, a bare `` `03` ``, `ADR 0001`,
 * or `CLAUDE.md`. Unknown tokens are ignored; the agent can still read anything in the repo.
 */
export function resolveSpecDocs(repoRoot: string, specRow: string): string[] {
  const docsDir = path.join(repoRoot, 'docs');
  const adrDir = path.join(docsDir, 'adr');
  const topLevel = fs.readdirSync(docsDir).filter((f) => /^\d{2}-.*\.md$/.test(f));
  const adrs = fs.readdirSync(adrDir).filter((f) => /^\d{4}-.*\.md$/.test(f));
  const found: string[] = [];
  const add = (p: string | undefined) => {
    if (p && !found.includes(p)) found.push(p);
  };

  for (const m of specRow.matchAll(/`(\d{2})(?:-[^`]*)?`/g)) {
    add(topLevel.filter((f) => f.startsWith(`${m[1]}-`)).map((f) => `docs/${f}`)[0]);
  }
  for (const m of specRow.matchAll(/ADR\s+(\d{4})/g)) {
    add(adrs.filter((f) => f.startsWith(`${m[1]}-`)).map((f) => `docs/adr/${f}`)[0]);
  }
  if (/CLAUDE\.md/.test(specRow)) add('CLAUDE.md');
  return found;
}
