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
import { capture, isFeatureEnabled } from '@audri/shared/posthog';
import { checkSpendCap } from '@audri/shared/usage';
import type { Task } from 'graphile-worker';
import { runAgentScopeIngestion } from '../ingestion/agent-scope.js';
import { fetchCandidatePages } from '../ingestion/candidate-pages.js';
import {
  agentNotesDirectsEnrichment,
  type EnrichmentLookupResult,
  lookupEnrichment,
} from '../ingestion/enrichment-lookup.js';
import { commitFanOut } from '../ingestion/commit.js';
import {
  FLASH_CANDIDATE_RETRIEVAL_MODEL,
  type IngestionTranscriptTurn,
  retrieveCandidates,
} from '../ingestion/flash-candidate-retrieval.js';
import { PRO_FAN_OUT_MODEL, runFanOut } from '../ingestion/pro-fan-out.js';
import { runSettingsSpecialist } from '../ingestion/settings-specialist.js';
import { classifyTranscript } from '../ingestion/traffic-director.js';
import { fetchUserWikiIndex } from '../ingestion/wiki-index.js';
import { logger } from '../logger.js';
import { recordInferenceUsage, recordWebSearchUsage } from '../usage/record-inference.js';

export interface IngestionPayload {
  transcriptId: string;
  userId: string;
  agentId: string;
  // Set by the retry-ingest controller when retrying a `partial` transcript:
  // agent-scope already wrote on the previous attempt, so re-running it would
  // duplicate. Skips the agent-scope branch and reruns user-scope only.
  userScopeOnly?: boolean;
  // Set by the retry-ingest controller when the user manually triggered a
  // re-ingest from the transcript UI (as opposed to an automatic retry of a
  // failed/partial job). Plumbed into the Pro fan-out prompt so the model can
  // bias toward more aggressive extraction — the user retried because they
  // believe something was missed.
  manualRetry?: boolean;
}

export const ingestion: Task = async (payload, helpers) => {
  const p = payload as IngestionPayload;
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    logger.info({ jobId: helpers.job.id, transcriptId: p.transcriptId, ...extra }, msg);

  // ── KILL SWITCH ─────────────────────────────────────────────────────────
  // PostHog feature flag `ingestion_enabled`. Defaults to enabled on flag
  // resolution failure (network down, key missing, flag undefined) — the
  // switch is for explicit disable, not for accidentally bricking the
  // pipeline. Throws so graphile retries; if you really want to stop
  // ingestion, leave the flag off and the retries will burn through their
  // attempts harmlessly (or pause the queue another way).
  const ingestEnabled = await isFeatureEnabled('ingestion_enabled', p.userId);
  if (ingestEnabled === false) {
    log('ingestion disabled by feature flag — skip');
    capture(p.userId, 'ingestion.skipped_by_flag', { transcriptId: p.transcriptId });
    return;
  }

  capture(p.userId, 'ingestion.started', {
    transcriptId: p.transcriptId,
    jobId: helpers.job.id,
  });

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

  // ── Traffic director ────────────────────────────────────────────────────
  // Pre-Pro routing layer. Pure heuristic for the empty-bypass branch;
  // task_only + settings_only branches deferred until specialists land
  // (see apps/worker/src/ingestion/traffic-director.ts). Bias toward
  // standard under uncertainty — false-negative on a fast-path is just
  // wasted inference, false-positive is silent information loss.
  const classification = classifyTranscript(
    transcript,
    transcriptRow.durationSeconds ?? null,
  );
  log('traffic-director: routing decision', {
    route: classification.route,
    reason: classification.reason,
    userTurnCount: classification.userTurnCount,
    userWordCount: classification.userWordCount,
    agentTurnCount: classification.agentTurnCount,
    durationSeconds: classification.durationSeconds,
    classifierLatencyMs: classification.classifierLatencyMs,
  });
  capture(p.userId, 'ingestion.traffic_director', {
    transcriptId: p.transcriptId,
    route: classification.route,
    reason: classification.reason,
    userTurnCount: classification.userTurnCount,
    userWordCount: classification.userWordCount,
    agentTurnCount: classification.agentTurnCount,
    durationSeconds: classification.durationSeconds,
  });

  if (classification.route === 'empty') {
    log('empty-bypass — no downstream services fired');
    await db
      .update(callTranscripts)
      .set({ ingestionStatus: 'succeeded', ingestionError: null })
      .where(eq(callTranscripts.id, p.transcriptId));
    return;
  }
  // task_only + settings_only paths fall through to standard below until
  // their specialists land — classifier currently never returns those.

  // Hard spending-cap pre-flight. Belt-and-suspenders with the server's
  // /end gate (the enqueue site) — covers the case where the user
  // crossed the cap between /end POST and worker pickup, AND retries
  // that re-enqueued without re-checking (older clients / direct SQL).
  const cap = await checkSpendCap(p.userId);
  if (cap.overCap) {
    log('skipping ingestion — user over monthly spend cap', {
      currentSpendCents: cap.currentSpendCents,
      limitCents: cap.limitCents,
    });
    await db
      .update(callTranscripts)
      .set({
        ingestionStatus: 'skipped_over_cap',
        ingestionError:
          'Monthly spending cap exceeded — raise the limit in Account → Usage to ingest this transcript.',
      })
      .where(eq(callTranscripts.id, p.transcriptId));
    capture(p.userId, 'ingestion.skipped_over_cap', {
      transcriptId: p.transcriptId,
      currentSpendCents: cap.currentSpendCents,
      limitCents: cap.limitCents,
    });
    return;
  }

  // Mark in-flight so retries can see the row is already being worked.
  await db
    .update(callTranscripts)
    .set({ ingestionStatus: 'running', ingestionError: null })
    .where(eq(callTranscripts.id, p.transcriptId));

  const callMetadata = {
    started_at: transcriptRow.startedAt.toISOString(),
    ended_at: (transcriptRow.endedAt ?? new Date()).toISOString(),
    end_reason: transcriptRow.endReason ?? 'user_ended',
  };

  // Extract URL citations from the live call's tool-call log. The mobile
  // client writes `tool_calls.groundingHits` on /end; we flatten + dedup
  // here, then pass into the fan-out pipeline so Pro can attribute claims
  // to the URLs that grounded them. Empty for calls with no web grounding.
  const groundingSources = extractGroundingSources(transcriptRow.toolCalls);
  if (groundingSources.length > 0) {
    log('grounding sources from live call', { count: groundingSources.length });
  }

  // Web-search billing — separate from URL citation. Each entry in any
  // grounding hit's `webSearchQueries[]` is one billable credit. Recorded
  // once per call as a single `web_search` usage_events row; cost computed
  // via WEB_SEARCH_USD_PER_REQUEST. Best-effort; failure logged but does
  // not block ingestion.
  const webSearchCredits = countWebSearchCredits(transcriptRow.toolCalls);
  if (webSearchCredits > 0) {
    log('web search credits from live call', { credits: webSearchCredits });
    await recordWebSearchUsage({
      userId: p.userId,
      agentId: p.agentId,
      callTranscriptId: p.transcriptId,
      credits: webSearchCredits,
    });
  }

  // ── User-scope and agent-scope passes run in parallel. Independent
  //    lifecycles per specs/agent-scope-ingestion.md — one failing doesn't
  //    block the other. On retry of a `partial` transcript, the controller
  //    sets userScopeOnly so we skip the agent-scope branch (it already
  //    wrote on the original attempt; re-running would duplicate).
  const userScopePromise = runUserScopePipeline(
    p,
    transcript,
    transcriptRow.startedAt,
    groundingSources,
    log,
  ).then((r) => {
    log('user-scope complete', { wrote: r.wrote });
    return r;
  });
  const agentScopePromise = p.userScopeOnly
    ? Promise.resolve({ skipped: true } as const)
    : runAgentScopeIngestion({
        transcriptId: p.transcriptId,
        userId: p.userId,
        agentId: p.agentId,
        transcript,
        callMetadata,
        userFirstName: null, // V1+ enrich via supabase admin lookup
      }).then((r) => {
        log('agent-scope complete', { ...r });
        return r;
      });

  const [userScopeResult, agentScopeResult] = await Promise.allSettled([
    userScopePromise,
    agentScopePromise,
  ]);

  if (userScopeResult.status === 'rejected') {
    logger.error({ err: userScopeResult.reason }, 'user-scope pipeline failed');
  }
  if (agentScopeResult.status === 'rejected') {
    logger.error({ err: agentScopeResult.reason }, 'agent-scope pipeline failed');
  }

  const userScopeFailed = userScopeResult.status === 'rejected';
  const agentScopeFailed = agentScopeResult.status === 'rejected';
  const isLastAttempt = (helpers.job.attempts ?? 1) >= (helpers.job.max_attempts ?? 1);

  // Both scopes failed → throw so graphile retries; mark `failed` on last
  // attempt so the banner's retry CTA can pick it up.
  if (userScopeFailed && agentScopeFailed) {
    if (isLastAttempt) {
      const reason = userScopeResult.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      await db
        .update(callTranscripts)
        .set({ ingestionStatus: 'failed', ingestionError: message })
        .where(eq(callTranscripts.id, p.transcriptId));
      capture(p.userId, 'ingestion.failed', {
        transcriptId: p.transcriptId,
        attempts: helpers.job.attempts ?? 1,
        error: message.slice(0, 200),
      });
    }
    throw userScopeResult.reason;
  }

  // User-scope failed but agent-scope wrote — mark `partial`. Don't throw:
  // re-running would duplicate agent-scope writes. The retry-ingest endpoint
  // accepts `partial` and re-enqueues with userScopeOnly=true.
  if (userScopeFailed && !agentScopeFailed) {
    const reason = userScopeResult.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    await db
      .update(callTranscripts)
      .set({ ingestionStatus: 'partial', ingestionError: message })
      .where(eq(callTranscripts.id, p.transcriptId));
    capture(p.userId, 'ingestion.partial', {
      transcriptId: p.transcriptId,
      attempts: helpers.job.attempts ?? 1,
      error: message.slice(0, 200),
      userScopeOnlyRetry: p.userScopeOnly === true,
    });
    return;
  }

  // User-scope succeeded. Two outcomes:
  //   - wrote=true  → real `succeeded` status (banner clears, content landed)
  //   - wrote=false → `zero_claims` status (pipeline ran cleanly but produced
  //     no writes — Flash dump, noteworthiness gate, Pro-skipped-everything,
  //     or commit-dropped malformed payload). The UI surfaces a retry CTA so
  //     the user can re-trigger ingestion when they believe something was
  //     missed. Agent-scope may still have failed silently — logged above.
  const userScopeWrote = userScopeResult.status === 'fulfilled' && userScopeResult.value.wrote;
  const finalStatus: 'succeeded' | 'zero_claims' = userScopeWrote ? 'succeeded' : 'zero_claims';

  await db
    .update(callTranscripts)
    .set({ ingestionStatus: finalStatus, ingestionError: null })
    .where(eq(callTranscripts.id, p.transcriptId));

  capture(p.userId, 'ingestion.succeeded', {
    transcriptId: p.transcriptId,
    finalStatus,
    userScope: userScopeResult.status,
    agentScope: agentScopeResult.status,
    userScopeOnly: p.userScopeOnly === true,
    manualRetry: p.manualRetry === true,
  });
};

async function runUserScopePipeline(
  p: IngestionPayload,
  transcript: IngestionTranscriptTurn[],
  callTimestamp: Date,
  groundingSources: Array<{ uri: string; title?: string; domain?: string }>,
  log: (msg: string, extra?: Record<string, unknown>) => void,
): Promise<{ wrote: boolean }> {
  const wikiIndex = await fetchUserWikiIndex(p.userId);
  log(`wiki index size = ${wikiIndex.length}`);

  // Settings specialist runs in parallel with Flash candidate retrieval +
  // Pro fan-out. Captures user customization directives ("from now on, X
  // = Y") into user_custom_rules. Independent of Pro's commit path —
  // separate transaction, separate write target (user_custom_rules vs
  // wiki_sections). Fires regardless of whether Flash dumps the call:
  // settings-only calls ("from now on, always cite sources" → hang up)
  // still capture their rule. See specs/customization-framework.md § 5/6.
  const settingsSpecialistPromise = runSettingsSpecialist({
    userId: p.userId,
    agentId: p.agentId,
    callTranscriptId: p.transcriptId,
    transcript,
    candidatePageSlugs: wikiIndex.map((e) => e.slug),
  }).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), transcriptId: p.transcriptId },
      'settings-specialist: threw at top level (non-fatal to ingestion)',
    );
    return { rulesInserted: 0, rulesUpdated: 0, rulesDeleted: 0, operationsDropped: 0 };
  });

  const flashRetrievalResult = await retrieveCandidates(transcript, wikiIndex);
  const candidates = flashRetrievalResult.candidates;
  // Best-effort usage row for Flash candidate retrieval. Fires whether or
  // not the noteworthiness gate passes — Flash always ran, so Flash always
  // cost.
  await recordInferenceUsage({
    userId: p.userId,
    agentId: p.agentId,
    callTranscriptId: p.transcriptId,
    eventKind: 'ingestion_prefilter',
    model: FLASH_CANDIDATE_RETRIEVAL_MODEL,
    usage: flashRetrievalResult.usage,
  });
  log(
    `flash candidates: touched=${candidates.touched_pages.length}, new=${candidates.new_pages.length}`,
  );

  // Explicit dump from Flash — Flash decided the call is unsubstantive.
  // Skip Pro fan-out + commit. Transcript stays on call_transcripts;
  // nothing accretes onto the wiki. See the "Dumping a call" section of
  // flash-candidate-retrieval.ts's prompt for the bar. Settings specialist
  // continues to run in the background — settings-only calls still capture
  // their rules even when Flash dumps the call.
  if (candidates.dump) {
    log('flash dumped call — no fan-out', { reason: candidates.dump.reason });
    const settingsResult = await settingsSpecialistPromise;
    log('settings-specialist (post-dump)', { ...settingsResult });
    const settingsWrote =
      settingsResult.rulesInserted + settingsResult.rulesUpdated + settingsResult.rulesDeleted > 0;
    return { wrote: settingsWrote };
  }

  if (candidates.touched_pages.length === 0 && candidates.new_pages.length === 0) {
    log('noteworthiness gate failed — no fan-out');
    const settingsResult = await settingsSpecialistPromise;
    log('settings-specialist (post-no-fan-out)', { ...settingsResult });
    const settingsWrote =
      settingsResult.rulesInserted + settingsResult.rulesUpdated + settingsResult.rulesDeleted > 0;
    return { wrote: settingsWrote };
  }

  const touchedSlugs = candidates.touched_pages.map((tp) => tp.slug);
  const candidatePages = await fetchCandidatePages(p.userId, touchedSlugs);
  log(`fetched ${candidatePages.length}/${touchedSlugs.length} candidate pages`);

  // Pre-Pro enrichment lookups. For each new_page proposed by Flash whose
  // proposed parent has an agent_notes rule directing lookup-and-include
  // behavior, fire a single bounded Gemini Flash call with googleSearch
  // grounding to fetch the named fields. Results are passed into Pro as
  // structured input under `enrichmentLookups`, keyed by new-page slug.
  // Triggers are deterministic (rule presence + Flash's structural decision);
  // no LLM-in-the-loop deciding what to look up. See enrichment-lookup.ts
  // header + v0.3.0 dogfood pass that motivated this addition.
  const candidateBySlug = new Map(candidatePages.map((cp) => [cp.slug, cp]));
  const enrichmentLookups: Record<string, EnrichmentLookupResult> = {};
  const lookupTasks: Array<Promise<void>> = [];
  for (const np of candidates.new_pages) {
    const parentSlug = np.proposed_parent_slug;
    if (!parentSlug) continue;
    const parent = candidateBySlug.get(parentSlug);
    if (!parent || !agentNotesDirectsEnrichment(parent.agent_notes)) continue;
    const ruleExcerpt = parent.agent_notes ?? '';
    const query = `${np.proposed_title}`.trim();
    if (!query) continue;
    lookupTasks.push(
      (async () => {
        const result = await lookupEnrichment({
          query,
          fields: [], // open-ended; the rule excerpt carries the field guidance
          ruleExcerpt,
          userId: p.userId,
          agentId: p.agentId,
          callTranscriptId: p.transcriptId,
        });
        if (result) enrichmentLookups[np.proposed_slug] = result;
      })(),
    );
  }
  if (lookupTasks.length > 0) {
    log(`enrichment lookups firing: ${lookupTasks.length}`);
    await Promise.all(lookupTasks);
    log(`enrichment lookups complete: ${Object.keys(enrichmentLookups).length} succeeded`);
  }

  const fanOutReturn = await runFanOut({
    transcript,
    newPages: candidates.new_pages,
    touchedPages: candidatePages,
    callTimestamp,
    groundingSources,
    enrichmentLookups:
      Object.keys(enrichmentLookups).length > 0 ? enrichmentLookups : undefined,
    manualRetry: p.manualRetry === true,
  });
  const fanOut = fanOutReturn.result;
  await recordInferenceUsage({
    userId: p.userId,
    agentId: p.agentId,
    callTranscriptId: p.transcriptId,
    eventKind: 'ingestion',
    model: PRO_FAN_OUT_MODEL,
    usage: fanOutReturn.usage,
  });
  log(
    `pro fan-out: creates=${fanOut.creates.length}, updates=${fanOut.updates.length}, skipped=${fanOut.skipped.length}, tasks=${fanOut.tasks.length}`,
  );

  const commitResult = await commitFanOut({
    userId: p.userId,
    transcriptId: p.transcriptId,
    agentId: p.agentId,
    fanOut,
    candidatePages,
    groundingSources,
  });
  log('user-scope commit complete', { ...commitResult });

  // Await settings specialist before the final write-decision. Captures
  // a settings-only contribution into `wrote` so a call that only set a
  // rule still marks ingestion succeeded (vs zero_claims).
  const settingsResult = await settingsSpecialistPromise;
  log('settings-specialist complete', { ...settingsResult });

  // "Wrote" means the commit produced at least one real write — page,
  // section, task, OR custom rule. Tombstones alone don't qualify
  // (they're cleanup, not capture). Drives the zero_claims status
  // decision in the caller.
  const wroteWiki =
    commitResult.pagesCreated +
      commitResult.pagesUpdated +
      commitResult.pagesMerged +
      commitResult.sectionsCreated +
      commitResult.sectionsUpdated +
      commitResult.sectionsMerged +
      commitResult.tasksCreated >
    0;
  const settingsWrote =
    settingsResult.rulesInserted + settingsResult.rulesUpdated + settingsResult.rulesDeleted > 0;
  const wrote = wroteWiki || settingsWrote;
  return { wrote };
}

// Count total `webSearchQueries` across all grounding hits in the tool
// log — that's the number of billable googleSearch credits the call
// consumed. Each query is 1 credit at $0.014 per credit (per pricing.ts).
// Defensive against missing/malformed shapes — returns 0 in any failure
// case so the absence of billing data never blocks ingestion.
function countWebSearchCredits(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const log = raw as { groundingHits?: unknown };
  if (!Array.isArray(log.groundingHits)) return 0;
  let total = 0;
  for (const hit of log.groundingHits) {
    if (!hit || typeof hit !== 'object') continue;
    const queries = (hit as { webSearchQueries?: unknown }).webSearchQueries;
    if (Array.isArray(queries)) total += queries.length;
  }
  return total;
}

// Flatten + dedup the mobile client's tool-call log into a list of unique
// grounding-source URLs. Defensive against shape drift — the log is jsonb
// and the mobile schema can evolve faster than the worker recompiles.
// Returns [] if the log is missing, malformed, or empty.
function extractGroundingSources(
  raw: unknown,
): Array<{ uri: string; title?: string; domain?: string }> {
  if (!raw || typeof raw !== 'object') return [];
  const log = raw as { groundingHits?: unknown };
  if (!Array.isArray(log.groundingHits)) return [];
  const seen = new Map<string, { uri: string; title?: string; domain?: string }>();
  for (const hit of log.groundingHits) {
    if (!hit || typeof hit !== 'object') continue;
    const chunks = (hit as { chunks?: unknown }).chunks;
    if (!Array.isArray(chunks)) continue;
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      const c = chunk as { uri?: unknown; title?: unknown; domain?: unknown };
      const uri = typeof c.uri === 'string' ? c.uri : undefined;
      if (!uri) continue;
      // First occurrence wins — duplicates across hits collapse, keeping
      // whatever title/domain came first (typically all hits for the same
      // URL carry identical metadata anyway).
      if (!seen.has(uri)) {
        seen.set(uri, {
          uri,
          title: typeof c.title === 'string' ? c.title : undefined,
          domain: typeof c.domain === 'string' ? c.domain : undefined,
        });
      }
    }
  }
  return [...seen.values()];
}
