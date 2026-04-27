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
import { CallsService } from './calls.service.js';

interface StartCallBody {
  agent_slug?: string;
  call_type?: 'generic' | 'onboarding';
}

interface EndCallBody {
  transcript: unknown;
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

    await db
      .update(callTranscripts)
      .set({
        content: (body.transcript as object) ?? [],
        toolCalls: (body.tool_calls as object) ?? null,
        endedAt: new Date(body.ended_at),
        endReason: body.end_reason ?? 'user_ended',
        cancelled: body.cancelled ?? false,
        droppedTurnIds: body.dropped_turn_ids ?? [],
      })
      .where(eq(callTranscripts.sessionId, sessionId));

    this.logger.log({ sessionId, userId: user.id }, 'call ended');
    // Slice 4: enqueue ingestion job here.
    return { status: 'ended', sessionId };
  }
}
