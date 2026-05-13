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
import { capture, isFeatureEnabled } from '@audri/shared/posthog';
import { checkSpendCap } from '@audri/shared/usage';
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

  // ── KILL SWITCH ─────────────────────────────────────────────────────────
  // Per-kind feature flag: `research_enabled` for research, etc. Keeps the
  // task in 'pending' so a re-enable resumes work — we don't mark cancelled
  // since the user didn't ask to cancel. Throws so graphile retries; the
  // retries will bounce off the same flag check until it flips on.
  const flagKey = `${task.kind}_enabled`;
  const kindEnabled = await isFeatureEnabled(flagKey, task.userId);
  if (kindEnabled === false) {
    log('agent_task kind disabled by feature flag — skip', { kind: task.kind });
    capture(task.userId, 'agent_task.skipped_by_flag', {
      kind: task.kind,
      agentTaskId: task.id,
    });
    return;
  }

  // Hard spending-cap pre-flight. Refuse to run the handler when the
  // user's monthly spend is at or over their configured limit. Mark
  // 'blocked_over_cap' instead of 'failed' so the Todos plugin can
  // render a distinct UX (raise limit + retry) rather than the standard
  // failure-retry path. User re-triggers after raising the cap.
  const cap = await checkSpendCap(task.userId);
  if (cap.overCap) {
    log('agent_task blocked — user over monthly spend cap', {
      kind: task.kind,
      currentSpendCents: cap.currentSpendCents,
      limitCents: cap.limitCents,
    });
    await db
      .update(agentTasks)
      .set({
        status: 'blocked_over_cap',
        lastError:
          'Monthly spending cap exceeded — raise the limit in Account → Usage to run this task.',
        updatedAt: new Date(),
      })
      .where(eq(agentTasks.id, task.id));
    capture(task.userId, 'agent_task.blocked_over_cap', {
      kind: task.kind,
      agentTaskId: task.id,
      currentSpendCents: cap.currentSpendCents,
      limitCents: cap.limitCents,
    });
    return;
  }

  // Mark in-flight.
  await db
    .update(agentTasks)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentTasks.id, task.id));

  capture(task.userId, 'agent_task.started', {
    kind: task.kind,
    agentTaskId: task.id,
  });

  try {
    if (task.kind === 'research') {
      const validatedPayload = ResearchPayloadZ.parse(task.payload);
      log('research handler starting', { query: validatedPayload.query });
      const result = await runResearch(task.userId, validatedPayload);
      const promptTokens = result.usage?.promptTokenCount ?? 0;
      const responseTokens = result.usage?.responseTokenCount ?? 0;
      log('research handler complete', {
        findings: result.output.findings.length,
        citations: result.output.citations.length,
        tokensIn: promptTokens,
        tokensOut: responseTokens,
      });
      await commitResearchOutput({
        userId: task.userId,
        agentTaskId: task.id,
        todoPageId: task.todoPageId,
        result,
      });
      log('research commit complete');
      capture(task.userId, 'agent_task.succeeded', {
        kind: task.kind,
        agentTaskId: task.id,
        tokensIn: promptTokens,
        tokensOut: responseTokens,
      });
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
      capture(task.userId, 'agent_task.failed', {
        kind: task.kind,
        agentTaskId: task.id,
        attempts: helpers.job.attempts ?? 1,
        error: message.slice(0, 200),
      });
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
