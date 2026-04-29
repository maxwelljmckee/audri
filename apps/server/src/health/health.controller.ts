import { Controller, Get, Headers, NotFoundException } from '@nestjs/common';
import * as Sentry from '@sentry/node';

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
  async sentryTest(@Headers('x-sentry-test') token?: string) {
    const expected = process.env.SUPABASE_WEBHOOK_SECRET;
    if (!expected || token !== expected) throw new NotFoundException();
    // Direct transport probe — bypasses the exception filter entirely. If
    // this message lands in Sentry but the throw below doesn't, the filter
    // is the broken layer. If neither lands, the issue is transport / DSN.
    const messageId = Sentry.captureMessage(
      'Sentry server smoke test — direct captureMessage',
      'info',
    );
    // Log the event ID so we can grep Render logs to confirm the SDK at least
    // generated an event ID locally.
    // eslint-disable-next-line no-console
    console.log('[sentry-test] captureMessage event id:', messageId);
    // Force flush so the event ships immediately rather than waiting for the
    // process exit / next interval — useful for debugging transport.
    await Sentry.flush(2000);
    throw new Error('Sentry smoke test — intentional 500');
  }
}
