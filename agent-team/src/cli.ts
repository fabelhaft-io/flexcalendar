import { parseArgs } from 'node:util';
import { runCoordinator } from './coordinator.js';
import { parseWritablePaths } from './lib/handoff.js';

const USAGE = `Usage: npm run dev-team -- <REQUIREMENT-ID> --paths <prefix>[,<prefix>...] [--with-reviewer] [--force]

  <REQUIREMENT-ID>   e.g. E02-R01; must exist as "### <ID> · …" in docs/epics/
  --paths            repo-relative paths the implementer may write. A trailing "/" grants a
                     directory tree; anything else grants exactly that file.
  --with-reviewer    also run the Mastra reviewer agent (opt-in; by default a human-side
                     reviewer reviews). Never pushes either way.
  --force            run even after the first attempt + 2 fix cycles are used up

Example: npm run dev-team -- E03-R01 --paths server/caldav/,infra/dev/`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      paths: { type: 'string' },
      'with-reviewer': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length !== 1 || !values.paths) {
    console.error(USAGE);
    return values.help ? 0 : 1;
  }
  const result = await runCoordinator({
    requirementId: positionals[0],
    writablePaths: parseWritablePaths(values.paths),
    withReviewer: values['with-reviewer'],
    force: values.force,
  });
  console.log(result.summary);
  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('dev-team run failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
