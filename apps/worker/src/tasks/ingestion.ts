// Ingestion job — runs the full transcript-to-wiki pipeline.
//
// Per build-plan slice 4 + specs/{flash-retrieval-prompt, fan-out-prompt,
// agent-scope-ingestion}.md.
//
// Pipeline stages:
//   1. Fetch transcript + wiki index
//   2. Flash candidate retrieval → { touched_pages, new_pages }
//   3. If both empty → noteworthiness gate fails, exit
//   4. Fetch fully-joined candidate pages
//   5. Pro fan-out → { creates, updates, skipped }
//   6. Transactional commit
//   7. Agent-scope pass (parallel) — task #49
//
// Per-user FIFO via queue_name = `ingestion-${user_id}` (set by the enqueue
// site in apps/server). Conservative retry (max_attempts = 2 per todos.md
// §11). Idempotency: handler is conceptually safe to retry, but DB writes
// will create duplicate sections on re-run — relies on the transactional
// commit + the at-least-once semantics being acceptable for MVP.

import { callTranscripts, db, eq } from '@audri/shared/db';
import type { Task } from 'graphile-worker';
import { logger } from '../logger.js';
import { runAgentScopeIngestion } from '../ingestion/agent-scope.js';
import { fetchCandidatePages } from '../ingestion/candidate-pages.js';
import { commitFanOut } from '../ingestion/commit.js';
import {
  type IngestionTranscriptTurn,
  retrieveCandidates,
} from '../ingestion/flash-candidate-retrieval.js';
import { runFanOut } from '../ingestion/pro-fan-out.js';
import { fetchUserWikiIndex } from '../ingestion/wiki-index.js';

export interface IngestionPayload {
  transcriptId: string;
  userId: string;
  agentId: string;
}

export const ingestion: Task = async (payload, helpers) => {
  const p = payload as IngestionPayload;
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    logger.info({ jobId: helpers.job.id, transcriptId: p.transcriptId, ...extra }, msg);

  // 1. Fetch transcript.
  const [transcriptRow] = await db
    .select()
    .from(callTranscripts)
    .where(eq(callTranscripts.id, p.transcriptId))
    .limit(1);
  if (!transcriptRow) {
    logger.warn({ transcriptId: p.transcriptId }, 'transcript not found — skip');
    return;
  }
  if (transcriptRow.cancelled) {
    log('transcript cancelled — skip');
    return;
  }

  const transcript = (transcriptRow.content as IngestionTranscriptTurn[]) ?? [];
  if (transcript.length === 0) {
    log('empty transcript — skip');
    return;
  }

  const callMetadata = {
    started_at: transcriptRow.startedAt.toISOString(),
    ended_at: (transcriptRow.endedAt ?? new Date()).toISOString(),
    end_reason: transcriptRow.endReason ?? 'user_ended',
  };

  // ── User-scope and agent-scope passes run in parallel. Independent
  //    lifecycles per specs/agent-scope-ingestion.md — one failing doesn't
  //    block the other.
  const [userScopeResult, agentScopeResult] = await Promise.allSettled([
    runUserScopePipeline(p, transcript, transcriptRow.startedAt, log),
    runAgentScopeIngestion({
      transcriptId: p.transcriptId,
      userId: p.userId,
      agentId: p.agentId,
      transcript,
      callMetadata,
      userFirstName: null, // V1+ enrich via supabase admin lookup
    }).then((r) => {
      log('agent-scope complete', { ...r });
      return r;
    }),
  ]);

  if (userScopeResult.status === 'rejected') {
    logger.error({ err: userScopeResult.reason }, 'user-scope pipeline failed');
  }
  if (agentScopeResult.status === 'rejected') {
    logger.error({ err: agentScopeResult.reason }, 'agent-scope pipeline failed');
  }

  // If BOTH fail, throw so graphile retries.
  if (userScopeResult.status === 'rejected' && agentScopeResult.status === 'rejected') {
    throw userScopeResult.reason;
  }
};

async function runUserScopePipeline(
  p: IngestionPayload,
  transcript: IngestionTranscriptTurn[],
  callTimestamp: Date,
  log: (msg: string, extra?: Record<string, unknown>) => void,
) {
  const wikiIndex = await fetchUserWikiIndex(p.userId);
  log(`wiki index size = ${wikiIndex.length}`);

  const candidates = await retrieveCandidates(transcript, wikiIndex);
  log(
    `flash candidates: touched=${candidates.touched_pages.length}, new=${candidates.new_pages.length}`,
  );

  if (candidates.touched_pages.length === 0 && candidates.new_pages.length === 0) {
    log('noteworthiness gate failed — no fan-out');
    return;
  }

  const touchedSlugs = candidates.touched_pages.map((tp) => tp.slug);
  const candidatePages = await fetchCandidatePages(p.userId, touchedSlugs);
  log(`fetched ${candidatePages.length}/${touchedSlugs.length} candidate pages`);

  const fanOut = await runFanOut({
    transcript,
    newPages: candidates.new_pages,
    touchedPages: candidatePages,
    callTimestamp,
  });
  log(
    `pro fan-out: creates=${fanOut.creates.length}, updates=${fanOut.updates.length}, skipped=${fanOut.skipped.length}, tasks=${fanOut.tasks.length}`,
  );

  const commitResult = await commitFanOut({
    userId: p.userId,
    transcriptId: p.transcriptId,
    fanOut,
    candidatePages,
  });
  log('user-scope commit complete', { ...commitResult });
}
