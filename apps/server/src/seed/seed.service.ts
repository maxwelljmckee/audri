import { Injectable, Logger } from '@nestjs/common';
import { db, agents, userSettings, wikiPages, and, eq, sql } from '@audri/shared/db';
import {
  AGENT_SCOPE_PAGES,
  ASSISTANT_AGENT,
  PROFILE_PAGES,
  TODO_PAGES,
} from './seed.constants.js';

export type SeedResult =
  | { status: 'created'; userId: string; agentId: string; pageCount: number }
  | { status: 'skipped'; userId: string; reason: 'already_seeded' };

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  // Atomic seed of 1 agents row + 20 wiki_pages + 1 user_settings.
  // Idempotent on user_id (re-firing webhook is safe).
  async seedNewUser(userId: string): Promise<SeedResult> {
    const existing = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.userId, userId),
          eq(wikiPages.scope, 'user'),
          eq(wikiPages.slug, 'profile'),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      this.logger.log({ userId }, 'seed already ran — skipping');
      return { status: 'skipped', userId, reason: 'already_seeded' };
    }

    const result = await db.transaction(async (tx) => {
      // Defer circular FKs to commit time so we can insert in any order
      // (agents.root_page_id ↔ wiki_pages.agent_id).
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

      // Pre-generate UUIDs so we can wire cross-references before insert.
      const agentRow = (
        await tx.execute(sql`SELECT gen_random_uuid() AS id`)
      )[0] as { id: string };
      const agentId = agentRow.id;

      const idRows = (await tx.execute(
        sql`SELECT gen_random_uuid() AS id FROM generate_series(1, 20)`,
      )) as { id: string }[];
      const pageIds = idRows.map((r) => r.id);

      const agentRootIdx = 0;
      const profileRootIdx = AGENT_SCOPE_PAGES.length;
      const todosRootIdx = AGENT_SCOPE_PAGES.length + PROFILE_PAGES.length;

      const allPages = [
        ...AGENT_SCOPE_PAGES.map((p, i) => ({
          id: pageIds[i] as string,
          userId,
          scope: 'agent' as const,
          type: 'agent' as const,
          slug: p.slug,
          parentPageId: i === 0 ? null : (pageIds[agentRootIdx] as string),
          title: p.title,
          agentAbstract: p.agentAbstract,
          agentId,
        })),
        ...PROFILE_PAGES.map((p, i) => ({
          id: pageIds[profileRootIdx + i] as string,
          userId,
          scope: 'user' as const,
          type: 'profile' as const,
          slug: p.slug,
          parentPageId: i === 0 ? null : (pageIds[profileRootIdx] as string),
          title: p.title,
          agentAbstract: p.agentAbstract,
          agentId: null,
        })),
        ...TODO_PAGES.map((p, i) => ({
          id: pageIds[todosRootIdx + i] as string,
          userId,
          scope: 'user' as const,
          type: 'todo' as const,
          slug: p.slug,
          parentPageId: i === 0 ? null : (pageIds[todosRootIdx] as string),
          title: p.title,
          agentAbstract: p.agentAbstract,
          agentId: null,
        })),
      ];

      await tx.insert(agents).values({
        id: agentId,
        userId,
        slug: ASSISTANT_AGENT.slug,
        name: ASSISTANT_AGENT.name,
        voice: ASSISTANT_AGENT.voice,
        personaPrompt: ASSISTANT_AGENT.personaPrompt,
        rootPageId: pageIds[agentRootIdx] as string,
        isDefault: true,
      });

      await tx.insert(wikiPages).values(allPages);

      await tx.insert(userSettings).values({ userId });

      return { agentId, pageCount: allPages.length };
    });

    this.logger.log(
      { userId, agentId: result.agentId, pageCount: result.pageCount },
      'seed complete',
    );
    return {
      status: 'created',
      userId,
      agentId: result.agentId,
      pageCount: result.pageCount,
    };
  }
}
