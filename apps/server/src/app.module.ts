import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { CallsModule } from './calls/calls.module.js';
import { HealthModule } from './health/health.module.js';
import { MeModule } from './me/me.module.js';
import { SeedModule } from './seed/seed.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { TodosModule } from './todos/todos.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { UserThrottlerGuard } from './throttler/user-throttler.guard.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : {
                target: 'pino-pretty',
                options: { colorize: true, singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
              },
        redact: {
          // Match the worker's redact set. Pino's `*.foo` matches depth-1
          // paths only — list both the bare key AND the wildcard form to
          // cover top-level + nested occurrences.
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'password', '*.password',
            'token', '*.token',
            'api_key', '*.api_key',
            // User content
            'transcript', '*.transcript',
            'content', '*.content',
            'query', '*.query',
            'summary', '*.summary',
            'payload', '*.payload',
            'snippets', '*.snippets',
            'snippet', '*.snippet',
            'findings', '*.findings',
            'notes_for_user', '*.notes_for_user',
            'context_summary', '*.context_summary',
          ],
          remove: true,
        },
      },
    }),
    // Per-user throttling. The user-keyed guard below substitutes auth.uid()
    // for the IP-based default so a single Render IP serving many users
    // doesn't share quota. Two named limiters: 'short' for high-cost calls,
    // 'long' for background per-day caps. Endpoints opt in via @Throttle().
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 60_000, limit: 30 }, // 30 req / min default
      { name: 'long', ttl: 24 * 60 * 60_000, limit: 500 }, // 500 / day default
    ]),
    HealthModule,
    SeedModule,
    WebhooksModule,
    MeModule,
    CallsModule,
    TasksModule,
    TodosModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
})
export class AppModule {}
