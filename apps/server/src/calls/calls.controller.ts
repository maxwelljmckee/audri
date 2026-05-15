import { callTranscripts, db, eq, sql, userSettings } from '@audri/shared/db';
import { LIVE_MODEL } from '@audri/shared/gemini';
import { checkSpendCap, recordInferenceUsage } from '@audri/shared/usage';
import type { UsageMetadata } from '@google/genai';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { CurrentUser } from '../auth/user.decorator.js';
import { CallsService } from './calls.service.js';
import { fetchPage, fetchTranscript, searchTranscripts, searchWiki } from './tools.js';
import type { TranscriptTurn } from './transcript.types.js';

interface StartCallBody {
  agent_slug?: string;
  call_type?: 'generic' | 'onboarding';
}

interface EndCallBody {
  transcript: TranscriptTurn[];
  tool_calls?: unknown;
  started_at: string;
  ended_at: string;
  end_reason?: 'user_ended' | 'silence_timeout' | 'network_drop' | 'app_backgrounded' | 'cancelled';
  cancelled?: boolean;
  dropped_turn_ids?: string[];
}

@Controller('calls')
@UseGuards(SupabaseAuthGuard)
export class CallsController {
  private readonly logger = new Logger(CallsController.name);

  constructor(@Inject(CallsService) private readonly calls: CallsService) {}

  // Calls are expensive (Gemini Live tokens, audio bandwidth). Cap to
  // ~10/hour and ~100/day per user — generous for legitimate use, hard
  // ceiling on runaway loops.
  @Throttle({ short: { limit: 10, ttl: 60 * 60_000 }, long: { limit: 100, ttl: 24 * 60 * 60_000 } })
  @Post('start')
  async start(@CurrentUser() user: { id: string }, @Body() body: StartCallBody) {
    // Hard spending-cap pre-flight. Refuse to mint the ephemeral token
    // when the user's monthly spend is at or over their configured limit.
    // Mobile maps 402 to a "monthly limit reached" state with deep-link
    // to the SetLimit modal so the user can raise the cap and retry.
    const cap = await checkSpendCap(user.id);
    if (cap.overCap) {
      throw new HttpException(
        {
          error: 'monthly_spend_cap_exceeded',
          message:
            'You have reached your monthly spending limit. Raise the limit in Account → Usage to continue.',
          current_spend_cents: cap.currentSpendCents,
          limit_cents: cap.limitCents,
          month_start: cap.monthStart,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    const agentSlug = body.agent_slug ?? 'assistant';
    const callType = body.call_type ?? 'generic';
    return this.calls.startCall({ userId: user.id, agentSlug, callType });
  }

  @Post(':sessionId/end')
  async end(
    @CurrentUser() user: { id: string },
    @Param('sessionId') sessionId: string,
    @Body() body: EndCallBody,
  ) {
    if (!body.started_at || !body.ended_at) {
      throw new BadRequestException('started_at + ended_at required');
    }

    const [existing] = await db
      .select()
      .from(callTranscripts)
      .where(eq(callTranscripts.sessionId, sessionId))
      .limit(1);
    if (!existing) throw new BadRequestException(`unknown session: ${sessionId}`);
    if (existing.userId !== user.id) throw new ConflictException('session does not belong to user');

    // Idempotency: if already ended, return current state without re-writing.
    if (existing.endedAt) {
      this.logger.log({ sessionId }, '/end called twice — returning existing');
      return { status: 'already_ended', sessionId };
    }

    const transcript = Array.isArray(body.transcript) ? body.transcript : [];
    const cancelled = body.cancelled ?? false;
    // Denormalize call length so the Usage dashboard + future Lite/Adaptive/
    // Pro routing can read it without recomputing from started_at/ended_at.
    // Floor to non-negative integer — defensive against clock skew between
    // mobile clock and server clock, which can produce small negative deltas.
    const endedAt = new Date(body.ended_at);
    const startedAt = existing.startedAt;
    const durationSeconds = Math.max(
      0,
      Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
    );

    // Hard spending-cap check: if the user crossed their cap mid-call,
    // skip the ingestion enqueue and mark the transcript with the new
    // 'skipped_over_cap' status. The call already happened (we don't
    // refuse mid-flight), but post-call inference is gated. The Notes
    // pending banner renders this status differently from 'failed' —
    // user sees a "raise limit to ingest" deep-link rather than retry.
    const cap = !cancelled && transcript.length > 0 ? await checkSpendCap(user.id) : null;
    const skipIngestForCap = cap?.overCap === true;

    // Atomic transcript update + ingestion enqueue. If either fails the whole
    // /end fails — no orphan rows or jobs. Cancelled calls skip the enqueue
    // (per todos.md §3 call_transcripts.cancelled spec).
    await db.transaction(async (tx) => {
      await tx
        .update(callTranscripts)
        .set({
          content: transcript,
          toolCalls: (body.tool_calls as object) ?? null,
          endedAt,
          durationSeconds,
          endReason: body.end_reason ?? 'user_ended',
          cancelled,
          droppedTurnIds: body.dropped_turn_ids ?? [],
          ...(skipIngestForCap
            ? {
                ingestionStatus: 'skipped_over_cap' as const,
                ingestionError:
                  'Monthly spending cap exceeded — raise the limit in Account → Usage to ingest this transcript.',
              }
            : {}),
        })
        .where(eq(callTranscripts.sessionId, sessionId));

      // Onboarding completion: any non-cancelled onboarding call with content
      // marks the user done. Resumption later goes through generic calls.
      if (existing.callType === 'onboarding' && !cancelled && transcript.length > 0) {
        await tx
          .update(userSettings)
          .set({ onboardingComplete: true, updatedAt: new Date() })
          .where(eq(userSettings.userId, user.id));
      }

      if (!cancelled && transcript.length > 0 && !skipIngestForCap) {
        const ingestionPayload = JSON.stringify({
          transcriptId: existing.id,
          userId: user.id,
          agentId: existing.agentId,
        });
        // Ingestion job: per-user FIFO via queue_name = `ingestion-${user_id}`.
        await tx.execute(sql`
          SELECT graphile_worker.add_job(
            'ingestion',
            ${ingestionPayload}::json,
            queue_name => ${`ingestion-${user.id}`},
            max_attempts => 3
          )
        `);
      }
    });

    // ── Live-session usage event ───────────────────────────────────────
    // The mobile client accumulates LiveServerMessage.usageMetadata
    // through the call (last-wins, since the SDK appears to emit
    // cumulative-since-session-start) and ships the latest snapshot in
    // body.tool_calls.sessionUsage. Write a `call_live` usage_events row
    // here so the Usage dashboard's "Live Agent" bucket includes the
    // session inference cost alongside post-call ingestion. Best-effort:
    // a failure to record usage MUST NOT fail /end (the call already
    // happened, ingestion's already enqueued).
    const sessionUsage = extractSessionUsage(body.tool_calls);
    if (sessionUsage) {
      try {
        await recordInferenceUsage({
          userId: user.id,
          agentId: existing.agentId,
          callTranscriptId: existing.id,
          eventKind: 'call_live',
          model: LIVE_MODEL,
          usage: sessionUsage,
          // Stash the call's wall-clock length on the usage row so the
          // Usage dashboard can do per-minute analytics + the future
          // Lite/Adaptive/Pro ingestion router can read it as one of
          // the signals for trivial-vs-complex routing.
          extras: { callDurationSeconds: durationSeconds },
        });
      } catch (err) {
        // Shared helper already swallows + logs; this catch is defense
        // in depth so a regression in the helper can't poison /end.
        this.logger.error({ err, sessionId }, 'call_live usage write threw (continuing)');
      }
    }

    // ── Dreaming "on call end" trigger ─────────────────────────────────
    // v0.3.0 B1 narrow custom hook: if the user has any active
    // dreaming automation with trigger_mode='on_call_end' for the
    // call's agent, spawn an agent_task now. Custom hook (not generic
    // event-trigger substrate); migrates to event-trigger once the
    // backlog entry lands. Skipped on cancelled / empty calls — no
    // call activity = nothing to dream about. Spawn is best-effort:
    // failure to enqueue logs but does NOT fail /end.
    if (!cancelled && transcript.length > 0 && !skipIngestForCap) {
      try {
        await this.maybeSpawnEveryCallDreaming({
          userId: user.id,
          agentId: existing.agentId,
          sessionId,
        });
      } catch (err) {
        this.logger.error({ err, sessionId }, 'dreaming on-call-end spawn threw (continuing)');
      }
    }

    this.logger.log({ sessionId, userId: user.id, cancelled }, 'call ended');
    return { status: 'ended', sessionId };
  }

  // Spawn a dream agent_task if the active agent has an "on_call_end"
  // dreaming automation enabled. Single small query + a conditional
  // insert; bounded per-call cost regardless of whether the hook fires.
  private async maybeSpawnEveryCallDreaming(opts: {
    userId: string;
    agentId: string;
    sessionId: string;
  }): Promise<void> {
    const matched = await db.execute(sql`
      SELECT id, payload
      FROM recurring_agent_tasks
      WHERE user_id = ${opts.userId}
        AND agent_id = ${opts.agentId}
        AND kind = 'dreaming'
        AND trigger_mode = 'on_call_end'
        AND paused = false
        AND tombstoned_at IS NULL
      LIMIT 1
    `);
    // db.execute() returns the postgres-js Result Array directly,
    // not a { rows } shape.
    const rows = matched as unknown as Array<{ id: string; payload: unknown }>;
    const reminder = rows[0];
    if (!reminder) return;

    await db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO agent_tasks (user_id, agent_id, kind, payload, status)
        VALUES (
          ${opts.userId},
          ${opts.agentId},
          'dreaming',
          ${JSON.stringify(reminder.payload ?? {})}::jsonb,
          'pending'
        )
        RETURNING id
      `);
      const newTaskId = (inserted as unknown as { rows?: Array<{ id: string }> }).rows?.[0]?.id;
      if (!newTaskId) throw new Error('on-call-end dreaming: agent_tasks insert returned no id');

      // Bookkeeping: bump the recurring row's last_run_at + last_agent_task_id
      // so the Automations UI surfaces the spawn even though it didn't fire
      // through the cron dispatcher.
      await tx.execute(sql`
        UPDATE recurring_agent_tasks
        SET last_run_at = now(),
            last_agent_task_id = ${newTaskId},
            updated_at = now()
        WHERE id = ${reminder.id}
      `);

      // Enqueue the standard agent_task_dispatch graphile job.
      const dispatchPayload = JSON.stringify({ agentTaskId: newTaskId });
      await tx.execute(sql`
        SELECT graphile_worker.add_job(
          'agent_task_dispatch',
          ${dispatchPayload}::json,
          max_attempts => 2
        )
      `);
    });

    this.logger.log(
      { sessionId: opts.sessionId, userId: opts.userId, agentId: opts.agentId },
      'on-call-end dreaming spawned',
    );
  }

  // Re-enqueue ingestion for any transcript in the user's history. Per
  // project_ingestion_philosophy + the Autonomy/Control UX principle, the
  // user owns the decision to re-run ingestion on any past call — not just
  // ones the system flagged as broken. Common reasons: zero_claims runs,
  // succeeded runs where the user notices missing content, partial/failed
  // recoveries.
  //
  // userScopeOnly handling: if agent-scope already wrote on a prior attempt,
  // re-running it would duplicate. agent-scope writes occur on every status
  // EXCEPT `failed` (where both scopes broke) and `skipped_over_cap` (where
  // the job never enqueued). So userScopeOnly defaults to true; only flip
  // it off for those two cases.
  //
  // manualRetry: true is set on the payload regardless of prior status — the
  // worker passes this into the Pro fan-out prompt so the model can bias
  // toward more aggressive extraction.
  @Post(':sessionId/retry-ingest')
  async retryIngest(@CurrentUser() user: { id: string }, @Param('sessionId') sessionId: string) {
    const [row] = await db
      .select()
      .from(callTranscripts)
      .where(eq(callTranscripts.sessionId, sessionId))
      .limit(1);
    if (!row) throw new BadRequestException(`unknown session: ${sessionId}`);
    if (row.userId !== user.id) throw new ConflictException('session does not belong to user');

    // Block retries while a prior run is mid-flight — the worker would
    // either race with itself on the same transcript or produce duplicate
    // writes if both attempts finish.
    if (row.ingestionStatus === 'pending' || row.ingestionStatus === 'running') {
      return { status: 'in-flight', sessionId, ingestionStatus: row.ingestionStatus };
    }

    // Same cap-check at retry: if the user is over their monthly limit,
    // refuse to re-enqueue. They need to raise the limit first.
    const cap = await checkSpendCap(user.id);
    if (cap.overCap) {
      throw new HttpException(
        {
          error: 'monthly_spend_cap_exceeded',
          message:
            'You have reached your monthly spending limit. Raise the limit in Account → Usage to retry this ingestion.',
          current_spend_cents: cap.currentSpendCents,
          limit_cents: cap.limitCents,
          month_start: cap.monthStart,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // Skip agent-scope re-run for any status where it already wrote. Only
    // `failed` (both scopes broke) and `skipped_over_cap` (nothing ran) are
    // safe to re-execute the full pipeline.
    const agentScopeAlreadyWrote =
      row.ingestionStatus !== 'failed' && row.ingestionStatus !== 'skipped_over_cap';
    const userScopeOnly = agentScopeAlreadyWrote;

    await db.transaction(async (tx) => {
      await tx
        .update(callTranscripts)
        .set({ ingestionStatus: 'pending', ingestionError: null })
        .where(eq(callTranscripts.id, row.id));

      const ingestionPayload = JSON.stringify({
        transcriptId: row.id,
        userId: user.id,
        agentId: row.agentId,
        userScopeOnly,
        manualRetry: true,
      });
      await tx.execute(sql`
        SELECT graphile_worker.add_job(
          'ingestion',
          ${ingestionPayload}::json,
          queue_name => ${`ingestion-${user.id}`},
          max_attempts => 3
        )
      `);
    });

    this.logger.log(
      { sessionId, userId: user.id, userScopeOnly, priorStatus: row.ingestionStatus },
      'manual ingestion retry enqueued',
    );
    return { status: 'retry-enqueued', sessionId, userScopeOnly };
  }

  // ── Live-agent tool endpoints ──────────────────────────────────────────
  // Audri emits function calls during a live call; mobile client receives
  // them over the Gemini WebSocket, hits these endpoints to fulfill, and
  // forwards the response back to Gemini via sendToolResponse. All run
  // under the user's JWT so RLS scopes results correctly.
  //
  // Throttled per-user to keep runaway tool-call loops from chewing through
  // request budget. 60 calls/min is generous — a real call rarely exceeds
  // 1–2 tool calls per minute.

  @Throttle({ short: { limit: 60, ttl: 60_000 } })
  @Post('tools/search_wiki')
  async toolSearchWiki(@CurrentUser() user: { id: string }, @Body() body: { query?: string }) {
    const query = (body.query ?? '').trim();
    if (!query) return { results: [] };
    const results = await searchWiki(user.id, query);
    // Best-effort usage breadcrumb. Tool hits Postgres only — zero
    // inference cost — but we record an event so per-call analytics can
    // surface tool-use frequency. Pass an empty UsageMetadata so the
    // helper inserts a row with cost_cents='0'.
    void recordInferenceUsage({
      userId: user.id,
      callTranscriptId: null,
      eventKind: 'tool_search_wiki',
      model: 'tool',
      usage: { totalTokenCount: 0 },
    }).catch(() => {
      // Swallow — observability write shouldn't fail the tool response.
    });
    return { results };
  }

  @Throttle({ short: { limit: 60, ttl: 60_000 } })
  @Post('tools/fetch_page')
  async toolFetchPage(@CurrentUser() user: { id: string }, @Body() body: { slug?: string }) {
    const slug = (body.slug ?? '').trim();
    if (!slug) throw new BadRequestException('slug required');
    const page = await fetchPage(user.id, slug);
    void recordInferenceUsage({
      userId: user.id,
      callTranscriptId: null,
      eventKind: 'tool_fetch_page',
      model: 'tool',
      usage: { totalTokenCount: 0 },
    }).catch(() => {
      // Swallow — observability write shouldn't fail the tool response.
    });
    if (!page) return { page: null, error: 'page not found' };
    return { page };
  }

  @Throttle({ short: { limit: 60, ttl: 60_000 } })
  @Post('tools/search_transcripts')
  async toolSearchTranscripts(
    @CurrentUser() user: { id: string },
    @Body() body: { query?: string },
  ) {
    const query = (body.query ?? '').trim();
    if (!query) return { results: [] };
    // Cap at 5 for the live agent — context discipline. The UI endpoint
    // below is uncapped so the user sees their full result set.
    const results = await searchTranscripts(user.id, query, 5);
    void recordInferenceUsage({
      userId: user.id,
      callTranscriptId: null,
      eventKind: 'tool_search_transcripts',
      model: 'tool',
      usage: { totalTokenCount: 0 },
    }).catch(() => {
      // Swallow — observability write shouldn't fail the tool response.
    });
    return { results };
  }

  // User-facing transcript search. Same SQL as the live-agent tool above,
  // but uncapped — the UI shows the full match set, sorted by date client-
  // side — and no usage_events row (UI keystroke-driven search would
  // pollute the per-tool analytics). Throttled at 60/min, comfortable with
  // client-side debounce. Powers the search input on the Chat History list.
  @Throttle({ short: { limit: 60, ttl: 60_000 } })
  @Post('transcripts/search')
  async transcriptsSearch(@CurrentUser() user: { id: string }, @Body() body: { query?: string }) {
    const query = (body.query ?? '').trim();
    if (!query) return { results: [] };
    const results = await searchTranscripts(user.id, query);
    return { results };
  }

  @Throttle({ short: { limit: 60, ttl: 60_000 } })
  @Post('tools/fetch_transcript')
  async toolFetchTranscript(
    @CurrentUser() user: { id: string },
    @Body() body: { transcript_id?: string },
  ) {
    const transcriptId = (body.transcript_id ?? '').trim();
    if (!transcriptId) throw new BadRequestException('transcript_id required');
    const transcript = await fetchTranscript(user.id, transcriptId);
    void recordInferenceUsage({
      userId: user.id,
      callTranscriptId: null,
      eventKind: 'tool_fetch_transcript',
      model: 'tool',
      usage: { totalTokenCount: 0 },
    }).catch(() => {
      // Swallow — observability write shouldn't fail the tool response.
    });
    if (!transcript) return { transcript: null, error: 'transcript not found' };
    return { transcript };
  }
}

// Pull the latest UsageMetadata snapshot out of the mobile client's
// tool_calls log. Mobile's `createToolCallLog` writes the field as
// `sessionUsage` (snake-cased through JSON), and the structure mirrors
// @google/genai's UsageMetadata type. Defensive against shape drift:
// returns undefined on any failure to parse so /end never fails on a
// malformed observability blob.
function extractSessionUsage(raw: unknown): UsageMetadata | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const log = raw as { sessionUsage?: unknown };
  if (!log.sessionUsage || typeof log.sessionUsage !== 'object') return undefined;
  // We don't fully validate every UsageMetadata field — the consumer
  // (`recordInferenceUsage` → `computeCostCents`) uses optional reads
  // with defaults, so a partial object still computes a sensible cost.
  return log.sessionUsage as UsageMetadata;
}
