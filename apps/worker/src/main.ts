import { run } from 'graphile-worker';
import { logger } from './logger.js';
import { initSentry } from './observability/sentry.js';
import { withSentry } from './observability/wrap-task.js';
import { dispatchAgentTask } from './tasks/dispatch-agent-task.js';
import { heartbeat } from './tasks/heartbeat.js';
import { ingestion } from './tasks/ingestion.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

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

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown received — stopping');
    clearInterval(interval);
    await runner.stop();
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
