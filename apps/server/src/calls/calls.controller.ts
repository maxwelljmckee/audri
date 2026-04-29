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
import { db, callTranscripts, eq, sql, userSettings } from '@audri/shared/db';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { CurrentUser } from '../auth/user.decorator.js';
import { CallsService } from './calls.service.js';
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
  async start(
    @CurrentUser() user: { id: string },
    @Body() body: StartCallBody,
  ) {
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

    // Atomic transcript update + ingestion enqueue. If either fails the whole
    // /end fails — no orphan rows or jobs. Cancelled calls skip the enqueue
    // (per todos.md §3 call_transcripts.cancelled spec).
    await db.transaction(async (tx) => {
      await tx
        .update(callTranscripts)
        .set({
          content: transcript,
          toolCalls: (body.tool_calls as object) ?? null,
          endedAt: new Date(body.ended_at),
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
            max_attempts => 2
          )
        `);
      }
    });

    this.logger.log({ sessionId, userId: user.id, cancelled }, 'call ended');
    return { status: 'ended', sessionId };
  }

  // Re-enqueue ingestion for a transcript whose previous run failed. Idempotent
  // by status: only re-fires when ingestion_status is currently 'failed' so a
  // double-tap doesn't queue duplicate work.
  @Post(':sessionId/retry-ingest')
  async retryIngest(
    @CurrentUser() user: { id: string },
    @Param('sessionId') sessionId: string,
  ) {
    const [row] = await db
      .select()
      .from(callTranscripts)
      .where(eq(callTranscripts.sessionId, sessionId))
      .limit(1);
    if (!row) throw new BadRequestException(`unknown session: ${sessionId}`);
    if (row.userId !== user.id) throw new ConflictException('session does not belong to user');

    if (row.ingestionStatus !== 'failed') {
      return { status: 'noop', sessionId, ingestionStatus: row.ingestionStatus };
    }

    await db.transaction(async (tx) => {
      await tx
        .update(callTranscripts)
        .set({ ingestionStatus: 'pending', ingestionError: null })
        .where(eq(callTranscripts.id, row.id));

      const ingestionPayload = JSON.stringify({
        transcriptId: row.id,
        userId: user.id,
        agentId: row.agentId,
      });
      await tx.execute(sql`
        SELECT graphile_worker.add_job(
          'ingestion',
          ${ingestionPayload}::json,
          queue_name => ${`ingestion-${user.id}`},
          max_attempts => 2
        )
      `);
    });

    this.logger.log({ sessionId, userId: user.id }, 'ingestion retry enqueued');
    return { status: 'retry-enqueued', sessionId };
  }
}
