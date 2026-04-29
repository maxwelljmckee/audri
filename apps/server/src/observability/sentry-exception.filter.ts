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
      Sentry.captureException(exception);
    }
    super.catch(exception, host);
  }
}
