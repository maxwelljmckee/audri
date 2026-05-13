import { agents, db, eq, sql, userSettings } from '@audri/shared/db';
import { invalidateSpendCap } from '@audri/shared/usage';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { getSupabaseAdmin } from '../auth/supabase.client.js';
import { CurrentUser } from '../auth/user.decorator.js';
import { aggregateMonthlyUsage } from './usage-aggregation.js';

@Controller('me')
@UseGuards(SupabaseAuthGuard)
export class MeController {
  private readonly logger = new Logger(MeController.name);

  // Bootstrap payload for the mobile client after sign-in.
  // RxDB sync replaces this in slice 5.
  // Per agents-and-scope.md Invariant 3: agents projection MUST NOT include
  // persona_prompt or user_prompt_notes.
  @Get()
  async me(@CurrentUser() user: { id: string; email?: string }) {
    const [agentRows, settingsRow] = await Promise.all([
      db
        .select({
          id: agents.id,
          slug: agents.slug,
          name: agents.name,
          voice: agents.voice,
          rootPageId: agents.rootPageId,
          isDefault: agents.isDefault,
          createdAt: agents.createdAt,
          tombstonedAt: agents.tombstonedAt,
        })
        .from(agents)
        .where(eq(agents.userId, user.id)),
      db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1),
    ]);

    return {
      user: { id: user.id, email: user.email },
      agents: agentRows,
      userSettings: settingsRow[0] ?? null,
    };
  }

  // Account tombstone — MVP scope per `build-plan.md` slice 9. Sets the
  // user_settings.tombstoned_at flag, revokes all active Supabase sessions
  // (so any in-flight tabs get logged out on next request), and leaves data
  // intact. The auth guard rejects requests from tombstoned users on every
  // subsequent call, including any sign-back-in attempts.
  //
  // Hard-delete + data export are V1+ per `backlog.md` (Account deletion
  // flow / Data export). The user can request hard-delete via support until
  // we ship that flow.
  @Delete()
  async deleteAccount(@CurrentUser() user: { id: string }) {
    this.logger.log({ userId: user.id }, 'account tombstone requested');
    await db
      .update(userSettings)
      .set({ tombstonedAt: sql`now()`, updatedAt: new Date() })
      .where(eq(userSettings.userId, user.id));
    // Revoke active sessions so any open clients get kicked out. This does
    // NOT delete the auth.users row — the user can theoretically sign back
    // in but the auth guard will reject every request because tombstoned_at
    // is set.
    const { error } = await getSupabaseAdmin().auth.admin.signOut(user.id, 'global');
    if (error) {
      // Non-fatal: tombstone flag is set; sessions will expire naturally.
      this.logger.warn({ err: error, userId: user.id }, 'session revoke failed (non-fatal)');
    }
    this.logger.log({ userId: user.id }, 'account tombstoned');
    return { status: 'tombstoned' };
  }

  // ── Spending limit (v0.2.1 Usage cycle, soft-only) ─────────────────────
  // PUT a monthly spend cap (cents) + optional warning threshold (0..1).
  // Soft-only at v0.2.1 — surfaces as a progress bar + banner on the
  // Usage screen. Server does NOT yet block inference when over limit.
  //
  // Pass `limit_cents: null` to clear the limit entirely.
  @Put('spending-limit')
  async setSpendingLimit(
    @CurrentUser() user: { id: string },
    @Body() body: { limit_cents?: number | null; threshold?: number },
  ) {
    const limitCents = body.limit_cents;
    const threshold = body.threshold;
    if (limitCents !== undefined && limitCents !== null && limitCents < 0) {
      throw new BadRequestException('limit_cents must be non-negative or null');
    }
    if (threshold !== undefined && (threshold <= 0 || threshold > 1)) {
      throw new BadRequestException('threshold must be in (0, 1]');
    }

    // Build the update payload only with fields the client actually sent
    // — undefined keys mean "leave unchanged."
    const update: Partial<typeof userSettings.$inferInsert> = { updatedAt: new Date() };
    if (limitCents !== undefined) {
      // Drizzle accepts NUMERIC as a string. null → SQL NULL (clears the cap).
      update.monthlySpendLimitCents = limitCents === null ? null : String(limitCents);
    }
    if (threshold !== undefined) {
      update.monthlySpendWarningThreshold = threshold;
    }

    await db.update(userSettings).set(update).where(eq(userSettings.userId, user.id));
    // Invalidate the cached cap decision so the next inference call
    // picks up the new limit immediately rather than waiting for the
    // 60s TTL. Important when the user is racing back from "limit
    // reached" UX to make a call.
    invalidateSpendCap(user.id);
    this.logger.log({ userId: user.id, limitCents, threshold }, 'spending limit updated');
    return { status: 'updated' };
  }

  // ── Timezone (mobile sends Intl.DateTimeFormat...resolvedOptions().timeZone) ─
  // Lightweight setter the mobile client calls on first launch (and on
  // device-locale changes). Used by the Usage aggregation endpoint for
  // user-local daily bucketing.
  @Put('timezone')
  async setTimezone(
    @CurrentUser() user: { id: string },
    @Body() body: { timezone?: string | null },
  ) {
    const tz = body.timezone;
    // Light validation — accept null (clear) or a string of IANA shape
    // (region/city). The Postgres `AT TIME ZONE` cast will reject
    // invalid names at aggregation time; full validation here would
    // require an IANA list which we'd have to keep updated.
    if (tz !== undefined && tz !== null && typeof tz !== 'string') {
      throw new BadRequestException('timezone must be a string or null');
    }
    if (typeof tz === 'string' && tz.length > 64) {
      throw new BadRequestException('timezone string too long');
    }
    await db
      .update(userSettings)
      .set({ timezone: tz ?? null, updatedAt: new Date() })
      .where(eq(userSettings.userId, user.id));
    return { status: 'updated' };
  }

  // ── Usage aggregation (Usage screen reads this) ────────────────────────
  // Returns the user's spend for a given calendar month, bucketed by
  // user-local day + by user-facing category, with the limit state for
  // the progress bar.
  //
  // Query param `month` defaults to the current month in the user's
  // timezone. Mobile passes 'YYYY-MM' for prior-month browsing (v0.2.1
  // ships current-month-only; the param is here for forward-compat).
  @Get('usage')
  async usage(@CurrentUser() user: { id: string }, @Query('month') monthParam?: string) {
    const [settings] = await db
      .select({
        timezone: userSettings.timezone,
        monthlySpendLimitCents: userSettings.monthlySpendLimitCents,
        monthlySpendWarningThreshold: userSettings.monthlySpendWarningThreshold,
      })
      .from(userSettings)
      .where(eq(userSettings.userId, user.id))
      .limit(1);

    const tz = settings?.timezone ?? null;
    // Compute the current YYYY-MM in the user's local time. Done with
    // Intl.DateTimeFormat to honor the tz without pulling a date library.
    const month = monthParam ?? currentMonthInTz(tz);

    return aggregateMonthlyUsage({
      userId: user.id,
      month,
      timezone: tz,
      monthlySpendLimitCents: settings?.monthlySpendLimitCents ?? null,
      monthlySpendWarningThreshold: settings?.monthlySpendWarningThreshold ?? 0.8,
    });
  }
}

// Compute 'YYYY-MM' for the current instant in the given IANA timezone.
// Falls back to UTC when tz is null. Intl is available everywhere we run
// (Node 18+) so no dep needed.
function currentMonthInTz(tz: string | null): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  if (!year || !month) return new Date().toISOString().slice(0, 7);
  return `${year}-${month}`;
}
