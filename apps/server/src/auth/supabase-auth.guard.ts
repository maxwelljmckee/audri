import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { and, db, eq, isNotNull, userSettings } from '@audri/shared/db';
import { getSupabaseAdmin } from './supabase.client.js';

export interface AuthedRequest extends Request {
  user: { id: string; email?: string };
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('missing bearer token');
    const jwt = header.slice('Bearer '.length).trim();

    const { data, error } = await getSupabaseAdmin().auth.getUser(jwt);
    if (error || !data.user) {
      this.logger.warn({ err: error?.message }, 'jwt validation failed');
      throw new UnauthorizedException('invalid token');
    }

    // Reject tombstoned accounts. Single small query keyed on user_id PK.
    const [tombstoned] = await db
      .select({ userId: userSettings.userId })
      .from(userSettings)
      .where(
        and(
          eq(userSettings.userId, data.user.id),
          isNotNull(userSettings.tombstonedAt),
        ),
      )
      .limit(1);
    if (tombstoned) {
      this.logger.warn({ userId: data.user.id }, 'tombstoned account attempted access');
      throw new ForbiddenException('account deactivated');
    }

    req.user = { id: data.user.id, email: data.user.email };
    return true;
  }
}
