import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { CallsModule } from './calls/calls.module.js';
import { HealthModule } from './health/health.module.js';
import { MeModule } from './me/me.module.js';
import { SeedModule } from './seed/seed.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';

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
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            '*.password',
            '*.token',
            '*.api_key',
          ],
          remove: true,
        },
      },
    }),
    HealthModule,
    SeedModule,
    WebhooksModule,
    MeModule,
    CallsModule,
  ],
})
export class AppModule {}
