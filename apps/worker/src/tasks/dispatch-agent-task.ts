// Generic agent_task dispatch — pulls a queued agent_tasks row, looks up the
// plugin registry by kind, runs the handler, commits results transactionally.
//
// Per todos.md §11 + specs/research-task-prompt.md.
//
// Failure handling:
//   - ValidationError (zod) → fail the task immediately (don't retry; bad output)
//   - LLM/network errors → throw, let Graphile retry up to maxAttempts
//   - On final failure → mark agent_tasks.status='failed', record error
//   - On success → commit handler result + mark status='succeeded'

import { agentTasks, db, eq, sql } from '@audri/shared/db';
import type { Task } from 'graphile-worker';
import { logger } from '../logger.js';
import { commitResearchOutput } from '../research/commit.js';
import { ResearchPayloadZ, runResearch } from '../research/handler.js';

export interface DispatchPayload {
  agentTaskId: string;
}

export const dispatchAgentTask: Task = async (payload, helpers) => {
  const p = payload as DispatchPayload;
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    logger.info({ jobId: helpers.job.id, agentTaskId: p.agentTaskId, ...extra }, msg);

  const [task] = await db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.id, p.agentTaskId))
    .limit(1);
  if (!task) {
    logger.warn({ agentTaskId: p.agentTaskId }, 'agent_task not found — skip');
    return;
  }

  if (task.status === 'succeeded' || task.status === 'cancelled') {
    log('task already terminal — skip', { status: task.status });
    return;
  }

  // Mark in-flight.
  await db
    .update(agentTasks)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentTasks.id, task.id));

  try {
    if (task.kind === 'research') {
      const validatedPayload = ResearchPayloadZ.parse(task.payload);
      log('research handler starting', { query: validatedPayload.query });
      const result = await runResearch(validatedPayload);
      log('research handler complete', {
        findings: result.output.findings.length,
        citations: result.output.citations.length,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      });
      await commitResearchOutput({
        userId: task.userId,
        agentTaskId: task.id,
        todoPageId: task.todoPageId,
        result,
      });
      log('research commit complete');
    } else {
      throw new Error(`unknown agent_task kind: ${task.kind}`);
    }
  } catch (err) {
    const isLastAttempt = (helpers.job.attempts ?? 1) >= (helpers.job.max_attempts ?? 1);
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, agentTaskId: task.id, isLastAttempt }, 'agent_task dispatch failed');

    if (isLastAttempt) {
      await db
        .update(agentTasks)
        .set({
          status: 'failed',
          lastError: message,
          retryCount: sql`${agentTasks.retryCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(agentTasks.id, task.id));
    } else {
      await db
        .update(agentTasks)
        .set({
          retryCount: sql`${agentTasks.retryCount} + 1`,
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(agentTasks.id, task.id));
    }
    throw err;
  }
};
