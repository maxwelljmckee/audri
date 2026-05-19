import { agents, and, db, eq, sql, userSettings, wikiPages } from '@audri/shared/db';
import { Injectable, Logger } from '@nestjs/common';
import {
  AGENT_SCOPE_PAGES,
  ASSISTANT_AGENT,
  BRAINDUMP_PAGES,
  PROFILE_PAGES,
  PROJECT_PAGES,
  TODO_PAGES,
} from './seed.constants.js';

export type SeedResult =
  | { status: 'created'; userId: string; agentId: string; pageCount: number }
  | { status: 'skipped'; userId: string; reason: 'already_seeded' };

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  // Atomic seed of 1 agents row + 5 wiki_pages + 1 user_settings.
  // (1 agent-scope root + 1 profile root + 1 todos root + 1 projects root +
  // 1 braindump root.) Idempotent on user_id (re-firing webhook is safe).
  // v0.2.1: todo status buckets dropped — sidecar owns status now.
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
      const agentRow = (await tx.execute(sql`SELECT gen_random_uuid() AS id`))[0] as { id: string };
      const agentId = agentRow.id;

      const totalPages =
        AGENT_SCOPE_PAGES.length +
        PROFILE_PAGES.length +
        TODO_PAGES.length +
        PROJECT_PAGES.length +
        BRAINDUMP_PAGES.length;
      const idRows = (await tx.execute(
        sql`SELECT gen_random_uuid() AS id FROM generate_series(1, ${totalPages})`,
      )) as { id: string }[];
      const pageIds = idRows.map((r) => r.id);

      const agentRootIdx = 0;
      const profileRootIdx = AGENT_SCOPE_PAGES.length;
      const todosRootIdx = AGENT_SCOPE_PAGES.length + PROFILE_PAGES.length;
      const projectsRootIdx = AGENT_SCOPE_PAGES.length + PROFILE_PAGES.length + TODO_PAGES.length;
      const braindumpRootIdx =
        AGENT_SCOPE_PAGES.length +
        PROFILE_PAGES.length +
        TODO_PAGES.length +
        PROJECT_PAGES.length;

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
          // No human-readable abstract on agent-scope pages — they're persona-
          // private and never surface in user-facing UI.
          abstract: null,
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
          abstract: 'abstract' in p ? p.abstract : null,
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
          // Todo bucket pages get no subtitle in the UI per the v0.2 design
          // call (per-bucket descriptions would clutter the tab strip).
          abstract: null,
          agentId: null,
        })),
        ...PROJECT_PAGES.map((p, i) => ({
          id: pageIds[projectsRootIdx + i] as string,
          userId,
          scope: 'user' as const,
          type: 'project' as const,
          slug: p.slug,
          parentPageId: i === 0 ? null : (pageIds[projectsRootIdx] as string),
          title: p.title,
          agentAbstract: p.agentAbstract,
          abstract: 'abstract' in p ? p.abstract : null,
          agentId: null,
        })),
        ...BRAINDUMP_PAGES.map((p, i) => ({
          id: pageIds[braindumpRootIdx + i] as string,
          userId,
          scope: 'user' as const,
          type: 'braindump' as const,
          slug: p.slug,
          parentPageId: i === 0 ? null : (pageIds[braindumpRootIdx] as string),
          title: p.title,
          agentAbstract: p.agentAbstract,
          abstract: 'abstract' in p ? p.abstract : null,
          agentId: null,
        })),
      ];

      await tx.insert(agents).values({
        id: agentId,
        userId,
        type: 'live',
        slug: ASSISTANT_AGENT.slug,
        name: ASSISTANT_AGENT.name,
        voice: ASSISTANT_AGENT.voice,
        personaPrompt: ASSISTANT_AGENT.personaPrompt,
        rootPageId: pageIds[agentRootIdx] as string,
        isDefault: true,
      });

      // Seed Rumi — the ingestion agent. Hidden from the Agents tile (per
      // specs/customization-framework.md Open Question A → Option B); the
      // row exists as substrate for knob binding (user_agent_settings) and
      // agent-scoped user_custom_rules. The operating prompt currently lives
      // in apps/worker/src/ingestion/pro-fan-out.ts; the persona_prompt
      // field here is a placeholder reserved for the prompt-decomposition
      // refactor. Voice is set to a placeholder ('aoede') — ingestion agents
      // never play TTS so the value is unread at runtime.
      await tx.insert(agents).values({
        userId,
        type: 'ingestion',
        slug: 'rumi',
        name: 'Rumi',
        voice: 'aoede',
        personaPrompt:
          'You are Rumi, the ingestion agent. You translate user voice notes into wiki content. Your operating prompt lives in apps/worker/src/ingestion/pro-fan-out.ts; this field is reserved for future per-user persona customization (see specs/customization-framework.md).',
        isDefault: false,
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
