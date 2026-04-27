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

  // 2. Fetch wiki index for the user.
  const wikiIndex = await fetchUserWikiIndex(p.userId);
  log(`wiki index size = ${wikiIndex.length}`);

  // 3. Flash candidate retrieval.
  const candidates = await retrieveCandidates(transcript, wikiIndex);
  log(`flash candidates: touched=${candidates.touched_pages.length}, new=${candidates.new_pages.length}`);

  if (candidates.touched_pages.length === 0 && candidates.new_pages.length === 0) {
    log('noteworthiness gate failed — no fan-out');
    return;
  }

  // 4. Fully-joined candidate pages for Pro.
  const touchedSlugs = candidates.touched_pages.map((p) => p.slug);
  const candidatePages = await fetchCandidatePages(p.userId, touchedSlugs);
  log(`fetched ${candidatePages.length}/${touchedSlugs.length} candidate pages`);

  // 5. Pro fan-out.
  const fanOut = await runFanOut({
    transcript,
    newPages: candidates.new_pages,
    touchedPages: candidatePages,
    callTimestamp: transcriptRow.startedAt,
  });
  log(
    `pro fan-out: creates=${fanOut.creates.length}, updates=${fanOut.updates.length}, skipped=${fanOut.skipped.length}`,
  );

  // 6. Transactional commit.
  const commitResult = await commitFanOut({
    userId: p.userId,
    transcriptId: p.transcriptId,
    fanOut,
    candidatePages,
  });
  log('commit complete', { ...commitResult });

  // 7. Agent-scope pass — lands in task #49.
};
