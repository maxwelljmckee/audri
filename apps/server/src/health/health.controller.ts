import { Controller, Get, Headers, NotFoundException } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      service: 'audri-server',
      timestamp: new Date().toISOString(),
    };
  }

  // Sentry smoke test. Throws an error so the global SentryExceptionFilter
  // captures it. Gated by a header that must match SUPABASE_WEBHOOK_SECRET
  // (reusing an existing secret rather than introducing a new one). The
  // handler 404s if the header is wrong so the endpoint isn't discoverable.
  @Get('sentry-test')
  sentryTest(@Headers('x-sentry-test') token?: string) {
    const expected = process.env.SUPABASE_WEBHOOK_SECRET;
    if (!expected || token !== expected) throw new NotFoundException();
    throw new Error('Sentry smoke test — intentional 500');
  }
}
