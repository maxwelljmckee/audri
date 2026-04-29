// Throttler guard keyed by authenticated user id, not by IP. The default
// IP-based key would conflate every user behind a shared egress (Render's
// outbound, the Supabase Auth proxy, etc.). For unauthenticated requests we
// fall back to IP — those should be rare (only health + webhooks).

import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = (req as { user?: { id?: string } }).user;
    if (user?.id) return `u:${user.id}`;
    // Fallback to IP. NestJS sets req.ip from the incoming connection.
    const ip = (req as { ip?: string }).ip ?? 'anon';
    return `ip:${ip}`;
  }

  // Skip throttling for any path served before SupabaseAuthGuard runs (the
  // user object isn't on req yet for those). Today that's just /health +
  // /webhooks/*. Cheap allowlist; tighten if those routes need throttling.
  protected override shouldSkip(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ url?: string }>();
    const url = req.url ?? '';
    if (url.startsWith('/health') || url.startsWith('/webhooks/')) {
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
}
