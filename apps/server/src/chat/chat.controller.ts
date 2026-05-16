// Streaming chat endpoint. POST /chat/turn streams the agent's response
// back as chunked plain text — mobile client reads with expo/fetch's
// streaming body reader and appends chunks to the iMessage bubble.
//
// Tool calls happen entirely server-side: the loop in ChatService runs
// search_wiki / fetch_page / search_transcripts / fetch_transcript /
// googleSearch as needed before yielding the next text chunk. The client
// sees only text.

import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { CurrentUser } from '../auth/user.decorator.js';
import { ChatService, type ChatTurn } from './chat.service.js';

interface ChatTurnBody {
  session_id?: string;
  user_text?: string;
  history?: ChatTurn[];
}

@Controller('chat')
@UseGuards(SupabaseAuthGuard)
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  // Per-user throttling. Chat turns are cheaper than live audio but still
  // hit the model; 30/min is generous for typing speed, hard ceiling on
  // runaway loops.
  @Throttle({ short: { limit: 30, ttl: 60_000 }, long: { limit: 1000, ttl: 24 * 60 * 60_000 } })
  @Post('turn')
  async turn(
    @CurrentUser() user: { id: string },
    @Body() body: ChatTurnBody,
    @Res() res: Response,
  ) {
    const sessionId = (body.session_id ?? '').trim();
    const userText = (body.user_text ?? '').trim();
    const history = Array.isArray(body.history) ? body.history : [];
    if (!sessionId) throw new BadRequestException('session_id required');
    if (!userText) throw new BadRequestException('user_text required');

    // Chunked text response. Set headers BEFORE any res.write — Express
    // locks the status + headers on the first body write. text/plain
    // gives the simplest reader on the mobile side; we don't need SSE
    // framing since tool calls are invisible to the client.
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no'); // disable any upstream buffering (Render/CF)

    try {
      await this.chat.runTurn({
        userId: user.id,
        sessionId,
        history,
        userText,
        onChunk: (chunk) => {
          res.write(chunk);
        },
      });
      res.end();
    } catch (err) {
      // If we've already started streaming, we can't change the status —
      // append a marker the client can detect and end. If we haven't,
      // surface the proper status code.
      if (res.headersSent) {
        this.logger.error({ err, sessionId }, 'chat stream errored mid-flight');
        res.write('\n[error: stream failed]');
        res.end();
        return;
      }
      if (err instanceof Error && err.message === 'SPEND_CAP_EXCEEDED') {
        const cap = (
          err as Error & {
            spendCap?: { currentSpendCents: number; limitCents: number; monthStart: string };
          }
        ).spendCap;
        throw new HttpException(
          {
            error: 'monthly_spend_cap_exceeded',
            message:
              'You have reached your monthly spending limit. Raise the limit in Account → Usage to continue.',
            current_spend_cents: cap?.currentSpendCents,
            limit_cents: cap?.limitCents,
            month_start: cap?.monthStart,
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      this.logger.error({ err, sessionId }, 'chat turn failed');
      throw err;
    }
  }
}
