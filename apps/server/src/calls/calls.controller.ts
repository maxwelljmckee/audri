import { callTranscripts, db, eq, sql, userSettings } from '@audri/shared/db';
import { LIVE_MODEL } from '@audri/shared/gemini';
import { recordInferenceUsage } from '@audri/shared/usage';
import type { UsageMetadata } from '@google/genai';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
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
import { fetchPage, searchWiki } from './tools.js';
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

      if (!cancelled && transcript.length > 0) {
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

    this.logger.log({ sessionId, userId: user.id, cancelled }, 'call ended');
    return { status: 'ended', sessionId };
  }

  // Re-enqueue ingestion for a transcript whose previous run didn't fully
  // succeed. Idempotent by status: only re-fires when ingestion_status is
  // `failed` (both scopes broke) or `partial` (user-scope broke, agent-scope
  // wrote). On `partial` we set userScopeOnly=true on the payload so the
  // worker skips re-running the agent-scope pass (which would duplicate
  // writes).
  @Post(':sessionId/retry-ingest')
  async retryIngest(@CurrentUser() user: { id: string }, @Param('sessionId') sessionId: string) {
    const [row] = await db
      .select()
      .from(callTranscripts)
      .where(eq(callTranscripts.sessionId, sessionId))
      .limit(1);
    if (!row) throw new BadRequestException(`unknown session: ${sessionId}`);
    if (row.userId !== user.id) throw new ConflictException('session does not belong to user');

    const retriable = row.ingestionStatus === 'failed' || row.ingestionStatus === 'partial';
    if (!retriable) {
      return { status: 'noop', sessionId, ingestionStatus: row.ingestionStatus };
    }

    const userScopeOnly = row.ingestionStatus === 'partial';

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

    this.logger.log({ sessionId, userId: user.id, userScopeOnly }, 'ingestion retry enqueued');
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
