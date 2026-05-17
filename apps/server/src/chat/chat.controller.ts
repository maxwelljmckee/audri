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

interface ChatStartBody {
  agent_slug?: string;
}

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

  // Lightweight session bootstrap. Spend-cap pre-flight + pre-creates
  // the call_transcripts row so /chat/turn can validate the sessionId
  // and /calls/:id/end can commit + ingest. Returns just the sessionId
  // — chat doesn't need an ephemeral token (no client-side Gemini
  // connection; everything routes through /chat/turn).
  @Throttle({ short: { limit: 10, ttl: 60 * 60_000 }, long: { limit: 100, ttl: 24 * 60 * 60_000 } })
  @Post('start')
  async start(@CurrentUser() user: { id: string }, @Body() body: ChatStartBody) {
    const agentSlug = body.agent_slug ?? 'assistant';
    try {
      return await this.chat.startChat({ userId: user.id, agentSlug });
    } catch (err) {
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
      throw err;
    }
  }

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

    // Server-Sent Events response. SSE bypasses iOS URLSession's
    // buffering threshold for small chunked responses (the previous
    // text/plain path delivered tokens in one big chunk on RN clients),
    // and the well-known content-type is what most CDNs / proxies
    // recognize as "don't buffer this".
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx-style upstream buffering
    res.flushHeaders();
    // Prime the stream with a comment frame (`:` lines are SSE comments,
    // ignored by clients) so any intermediate proxy that holds the
    // response open until first byte gets unblocked immediately.
    res.write(': stream open\n\n');

    try {
      await this.chat.runTurn({
        userId: user.id,
        sessionId,
        history,
        userText,
        onChunk: (chunk) => {
          // SSE frame format: each data line starts with `data: `;
          // multi-line payloads need `data: ` on each line. End with
          // blank line (\n\n) to mark the frame boundary.
          const payload = chunk.replace(/\n/g, '\ndata: ');
          res.write(`data: ${payload}\n\n`);
        },
      });
      // Final "done" frame — distinct event so the client can tell the
      // difference between "stream ended cleanly" and "socket closed
      // mid-flight". Not strictly necessary (`done=true` from
      // reader.read() also signals end), but cheap insurance.
      res.write('event: done\ndata: \n\n');
      res.end();
    } catch (err) {
      // If we've already started streaming, we can't change the status —
      // append a marker the client can detect and end. If we haven't,
      // surface the proper status code.
      if (res.headersSent) {
        this.logger.error({ err, sessionId }, 'chat stream errored mid-flight');
        res.write('event: error\ndata: stream failed\n\n');
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
