// NestJS exception filter that forwards unhandled errors to Sentry before
// delegating to Nest's default response handling. Mounted globally in main.ts.
//
// 4xx HttpExceptions are NOT captured — those are user-facing input errors,
// not server faults. 5xx + uncaught exceptions are captured.

import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';

@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter implements ExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost) {
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= 500) {
      const eventId = Sentry.captureException(exception);
      // Diagnostic log — confirms the filter ran AND the SDK accepted the
      // event. If you see this in Render logs but no event in Sentry, the
      // problem is between the SDK and Sentry's ingest endpoint (network,
      // DSN project mismatch, inbound filters, project-level rules).
      // eslint-disable-next-line no-console
      console.log('[sentry-filter] captured exception, event id:', eventId, 'status:', status);
    }
    super.catch(exception, host);
  }
}
