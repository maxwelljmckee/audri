import { Controller, Delete, Get, Logger, UseGuards } from '@nestjs/common';
import { db, agents, userSettings, eq, sql } from '@audri/shared/db';
import { getSupabaseAdmin } from '../auth/supabase.client.js';
import { CurrentUser } from '../auth/user.decorator.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';

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
}
