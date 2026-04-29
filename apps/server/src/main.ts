import 'reflect-metadata';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { SentryExceptionFilter } from './observability/sentry-exception.filter.js';
import { initSentry } from './observability/sentry.js';

async function bootstrap() {
  initSentry();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Forward unhandled 5xx exceptions to Sentry before Nest's default handler.
  const httpAdapter = app.get(HttpAdapterHost);
  app.useGlobalFilters(new SentryExceptionFilter(httpAdapter.httpAdapter));

  const port = Number(process.env.PORT ?? 8080);
  await app.listen(port);

  app.get(Logger).log(`Audri server listening on :${port}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
