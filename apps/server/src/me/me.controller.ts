import { Controller, Get, UseGuards } from '@nestjs/common';
import { db, agents, userSettings, eq } from '@audri/shared/db';
import { CurrentUser } from '../auth/user.decorator.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';

@Controller('me')
@UseGuards(SupabaseAuthGuard)
export class MeController {
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
}
