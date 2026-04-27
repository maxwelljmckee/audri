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
import { eq } from 'drizzle-orm';
import { CurrentUser } from '../auth/user.decorator.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { db } from '../db/client.js';
import { callTranscripts } from '../db/schema/index.js';
import { getSupabaseAdmin } from '../auth/supabase.client.js';
import { CallsService } from './calls.service.js';
import { generateTitleSummary } from './title-summary.js';
import type { TranscriptTurn } from './transcript.types.js';

// Pull a first name from Supabase Auth user_metadata (Google OAuth populates
// given_name / full_name / name). Returns null if nothing usable found.
async function fetchUserFirstName(userId: string): Promise<string | null> {
  try {
    const { data } = await getSupabaseAdmin().auth.admin.getUserById(userId);
    const meta = (data.user?.user_metadata ?? {}) as Record<string, unknown>;
    const given = typeof meta.given_name === 'string' ? meta.given_name : null;
    if (given) return given;
    const full = typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : null;
    if (full) return full.split(' ')[0] ?? null;
    return null;
  } catch {
    return null;
  }
}

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

    await db
      .update(callTranscripts)
      .set({
        content: transcript,
        toolCalls: (body.tool_calls as object) ?? null,
        endedAt: new Date(body.ended_at),
        endReason: body.end_reason ?? 'user_ended',
        cancelled: body.cancelled ?? false,
        droppedTurnIds: body.dropped_turn_ids ?? [],
      })
      .where(eq(callTranscripts.sessionId, sessionId));

    this.logger.log({ sessionId, userId: user.id }, 'call ended');

    // Title + summary via Flash, fire-and-forget. Don't block /end on it.
    // Slice 4 will move this into the Graphile worker alongside the
    // ingestion job for durability + retries.
    if (!body.cancelled) {
      void (async () => {
        try {
          const firstName = await fetchUserFirstName(user.id);
          const ts = await generateTitleSummary(transcript, firstName);
          if (!ts) return;
          await db
            .update(callTranscripts)
            .set({ title: ts.title || null, summary: ts.summary || null })
            .where(eq(callTranscripts.sessionId, sessionId));
          this.logger.log({ sessionId }, 'title + summary saved');
        } catch (err) {
          this.logger.warn(
            { sessionId, err: err instanceof Error ? err.message : err },
            'title + summary post-call failed',
          );
        }
      })();
    }

    // Slice 4: enqueue ingestion job here.
    return { status: 'ended', sessionId };
  }
}
