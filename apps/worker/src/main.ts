import { shutdownPosthog } from '@audri/shared/posthog';
import { run } from 'graphile-worker';
import { Agent, setGlobalDispatcher } from 'undici';
import { logger } from './logger.js';
import { initSentry } from './observability/sentry.js';
import { withSentry } from './observability/wrap-task.js';
import { dispatchAgentTask } from './tasks/dispatch-agent-task.js';
import { heartbeat } from './tasks/heartbeat.js';
import { hygieneSweep } from './tasks/hygiene-sweep.js';
import { ingestion } from './tasks/ingestion.js';

// undici (Node's built-in fetch) defaults to a 5-minute headers timeout.
// Pro fan-out calls on heavy transcripts (deep thinking budget + large
// touched-pages payload) can legitimately exceed that, producing
// HeadersTimeoutError flakes that look like Google API issues but are
// actually our client-side timer. 15 minutes covers worst-observed Pro
// runs with comfortable headroom; longer is strictly safer here because
// the worker is otherwise idle while a generateContent call is in flight.
// Affects every fetch in this process (Gemini SDK, Supabase admin, etc.) —
// none of them benefit from a tighter ceiling, so a global dispatcher
// override is the simplest reach.
const FETCH_TIMEOUT_MS = 15 * 60 * 1000;
setGlobalDispatcher(new Agent({ headersTimeout: FETCH_TIMEOUT_MS, bodyTimeout: FETCH_TIMEOUT_MS }));

const HEARTBEAT_INTERVAL_MS = 30_000;
// Daily — the hygiene sweep is a low-frequency cleanup; minute-level cron
// resolution would be wasteful. Run on app boot too so a worker restart
// doesn't skip a day.
const HYGIENE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  initSentry();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const runner = await run({
    connectionString,
    concurrency: 4,
    pollInterval: 1000,
    taskList: {
      heartbeat,
      ingestion: withSentry('ingestion', ingestion),
      agent_task_dispatch: withSentry('agent_task_dispatch', dispatchAgentTask),
      hygiene_sweep: withSentry('hygiene_sweep', hygieneSweep),
    },
  });

  logger.info('Audri worker started');

  // Self-enqueue heartbeat every 30s. Graphile cron is minute-resolution,
  // so we drive the heartbeat ourselves — exercises the queue too.
  const tick = () => {
    runner.addJob('heartbeat', {}).catch((err) => {
      logger.error({ err }, 'failed to enqueue heartbeat');
    });
  };
  tick();
  const interval = setInterval(tick, HEARTBEAT_INTERVAL_MS);

  // Hygiene sweep — daily cadence. Fires on boot too so a restart doesn't
  // skip a day. setInterval drift is fine at this resolution.
  const enqueueHygiene = () => {
    runner.addJob('hygiene_sweep', {}).catch((err) => {
      logger.error({ err }, 'failed to enqueue hygiene_sweep');
    });
  };
  enqueueHygiene();
  const hygieneInterval = setInterval(enqueueHygiene, HYGIENE_SWEEP_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown received — stopping');
    clearInterval(interval);
    clearInterval(hygieneInterval);
    await runner.stop();
    // Flush any buffered PostHog events before exit so we don't drop the
    // last batch on graceful restart.
    await shutdownPosthog();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runner.promise;
}

main().catch((err) => {
  logger.error({ err }, 'worker bootstrap failed');
  process.exit(1);
});
