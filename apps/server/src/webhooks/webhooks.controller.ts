import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { SeedService } from '../seed/seed.service.js';
import type { SupabaseSignupWebhookBody } from './supabase-signup.dto.js';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  // Explicit @Inject token because esbuild/tsx don't reliably emit
  // emitDecoratorMetadata for constructor parameter types.
  constructor(@Inject(SeedService) private readonly seedService: SeedService) {}

  @Post('supabase-signup')
  @HttpCode(200)
  async supabaseSignup(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: SupabaseSignupWebhookBody,
  ) {
    const expected = process.env.SUPABASE_WEBHOOK_SECRET;
    if (!expected) throw new UnauthorizedException('webhook secret not configured');
    if (authHeader !== expected) {
      this.logger.warn({ authHeader: authHeader?.slice(0, 8) }, 'webhook auth mismatch');
      throw new UnauthorizedException();
    }

    if (body.type !== 'INSERT' || body.schema !== 'auth' || body.table !== 'users') {
      this.logger.log(
        { type: body.type, table: body.table },
        'webhook ignored — not auth.users INSERT',
      );
      return { status: 'ignored' };
    }

    const userId = body.record?.id;
    if (!userId) throw new BadRequestException('missing record.id');

    const result = await this.seedService.seedNewUser(userId);
    return result;
  }
}
