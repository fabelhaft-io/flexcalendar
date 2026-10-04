import { runCoordinator } from './coordinator.js';

const ticketId = process.argv[2];

if (!ticketId) {
  console.error('Usage: npm run dev-team -- <TICKET-ID>');
  console.error('Example: npm run dev-team -- P6-007');
  process.exit(1);
}

runCoordinator(ticketId)
  .then((result) => {
    console.log(result.summary);
    process.exit(result.ok ? 0 : 1);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('dev-team run failed:', message);
    process.exit(1);
  });
