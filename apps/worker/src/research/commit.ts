// Research output commit — single transaction. Writes the artifact +
// citations + ancestor sources, **applies the vault-first delta to the
// user's wiki** (creates new pages + appends new sections), marks the
// agent_task succeeded, **flips the originating todo's sidecar status to
// 'done'**, emits usage_event + wiki_log.
//
// v0.2 added the delta-application step (item #8).
// v0.2.1 swapped the todo-reparent-to-`todos/done` step for a sidecar
// status update — status lives on the `todos` table column now, not the
// wiki hierarchy.
//
// All in one transaction — if delta application fails, nothing commits.
//
// Per specs/research-task-prompt.md.

import {
  agentTasks,
  and,
  db,
  eq,
  inArray,
  isNull,
  researchOutputSources,
  researchOutputs,
  sql,
  todos,
  usageEvents,
  wikiLog,
  wikiPages,
  wikiSections,
} from '@audri/shared/db';
import { computeCostCents, tokenTotalsFromUsage } from '@audri/shared/usage';
import { logger } from '../logger.js';
import type { ResearchDelta, ResearchHandlerResult } from './handler.js';

interface CommitArgs {
  userId: string;
  agentTaskId: string;
  todoPageId: string;
  result: ResearchHandlerResult;
}

export interface CommitResult {
  researchOutputId: string;
  deltaPagesCreated: number;
  deltaSectionsAppended: number;
}

export async function commitResearchOutput(args: CommitArgs): Promise<CommitResult> {
  const { userId, agentTaskId, todoPageId, result } = args;
  const { output, modelUsed, usage } = result;

  // Tokens for the research_outputs.tokensIn/Out legacy columns + the
  // usage_events row. tokenTotalsFromUsage returns {input,output,cached}.
  // When usage is undefined (rare), tokens default to 0 — the row is
  // still useful as an audit breadcrumb even without billable counts.
  const tokens = usage ? tokenTotalsFromUsage(usage) : { input: 0, output: 0, cached: 0 };
  const tokensIn = tokens.input;
  const tokensOut = tokens.output;
  const costCents = usage ? computeCostCents(modelUsed, usage) : '0';

  return db.transaction(async (tx) => {
    // 1. Insert research_outputs row.
    const [row] = await tx
      .insert(researchOutputs)
      .values({
        userId,
        agentTasksId: agentTaskId,
        query: output.query,
        title: output.title,
        summary: output.summary,
        findings: output.findings,
        citations: output.citations,
        followUpQuestions: output.follow_up_questions ?? [],
        notesForUser: output.notes_for_user ?? null,
        modelUsed,
        tokensIn,
        tokensOut,
        // Explicit timestamp at insert — defense in depth on top of the
        // schema's defaultNow(). Removes any chance of the column being
        // ambiguous mid-pipeline; the Date here is what gets serialized to
        // ISO and replicated through Supabase to the client.
        generatedAt: new Date(),
      })
      .returning({ id: researchOutputs.id });
    if (!row) throw new Error('research_outputs insert returned no row');
    const researchOutputId = row.id;

    // 2. Insert per-citation source rows.
    if (output.citations.length > 0) {
      await tx.insert(researchOutputSources).values(
        output.citations.map((c, idx) => ({
          researchOutputId,
          url: c.url,
          title: c.title || null,
          snippet: c.snippet,
          citationIndex: idx + 1, // 1-indexed per spec
        })),
      );
    }

    // 2.5. Apply the vault-first delta to the user's wiki. Additive only —
    //      new pages + new sections under existing pages. No overwrites.
    const deltaResult = await applyResearchDelta(tx, {
      userId,
      delta: output.delta,
    });

    // 3. Mark agent_task succeeded.
    await tx
      .update(agentTasks)
      .set({
        status: 'succeeded',
        completedAt: new Date(),
        updatedAt: new Date(),
        resultArtifactKind: 'research',
        resultArtifactId: researchOutputId,
      })
      .where(eq(agentTasks.id, agentTaskId));

    // 4. Replace the originating todo's placeholder title with the LLM-
    //    generated abbreviated title (kept user-friendly + consistent with
    //    the artifact's title), AND flip the sidecar status → 'done'.
    //    v0.2.1: status used to live on parent_page_id (todos/done bucket);
    //    now it's a column on the `todos` sidecar.
    const todoTitle = `Research: ${output.title}`;
    await tx
      .update(wikiPages)
      .set({
        title: todoTitle,
        agentAbstract: `Research: ${output.title}`,
        updatedAt: new Date(),
      })
      .where(eq(wikiPages.id, todoPageId));

    await tx
      .update(todos)
      .set({
        status: 'done',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(todos.pageId, todoPageId));

    // 5. Usage event — cost computed via shared pricing module.
    await tx.insert(usageEvents).values({
      userId,
      agentTasksId: agentTaskId,
      eventKind: 'plugin_research',
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      cachedTokens: tokens.cached,
      model: modelUsed,
      costCents,
      artifactKind: 'research',
      artifactId: researchOutputId,
    });

    // 6. wiki_log breadcrumb. Includes delta counts so the activity stream
    //    can surface "research complete + N pages added + M sections added."
    await tx.insert(wikiLog).values({
      userId,
      kind: 'task',
      summary: `research complete: ${output.query.slice(0, 120)} (delta: +${deltaResult.pagesCreated}p / +${deltaResult.sectionsAppended}s)`,
      ref: {
        researchOutputId,
        agentTaskId,
        kind: 'research',
        deltaPagesCreated: deltaResult.pagesCreated,
        deltaSectionsAppended: deltaResult.sectionsAppended,
      },
    });

    return {
      researchOutputId,
      deltaPagesCreated: deltaResult.pagesCreated,
      deltaSectionsAppended: deltaResult.sectionsAppended,
    };
  });
}

// ── Delta application ────────────────────────────────────────────────────────

interface DeltaApplyArgs {
  userId: string;
  delta: ResearchDelta;
}

interface DeltaApplyResult {
  pagesCreated: number;
  sectionsAppended: number;
}

async function applyResearchDelta(
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's transaction type is generic-heavy
  tx: any,
  { userId, delta }: DeltaApplyArgs,
): Promise<DeltaApplyResult> {
  const counters: DeltaApplyResult = { pagesCreated: 0, sectionsAppended: 0 };

  // ── Resolve parent_slug → page_id for creates ──────────────────────────
  const parentSlugs = Array.from(new Set(delta.creates.map((c) => c.parent_slug)));
  const parentRows: { id: string; slug: string }[] =
    parentSlugs.length === 0
      ? []
      : await tx
          .select({ id: wikiPages.id, slug: wikiPages.slug })
          .from(wikiPages)
          .where(
            and(
              eq(wikiPages.userId, userId),
              eq(wikiPages.scope, 'user'),
              isNull(wikiPages.tombstonedAt),
              inArray(wikiPages.slug, parentSlugs),
            ),
          );
  const parentIdBySlug = new Map(parentRows.map((r) => [r.slug, r.id]));

  // ── Apply creates ──────────────────────────────────────────────────────
  for (const create of delta.creates) {
    const parentId = parentIdBySlug.get(create.parent_slug);
    if (!parentId) {
      // Defensive: model invented a parent_slug that doesn't exist in the
      // user's wiki. Skip the create rather than fail the whole commit.
      logger.warn(
        { slug: create.slug, parentSlug: create.parent_slug },
        'research delta: skipping create with unresolvable parent_slug',
      );
      continue;
    }

    // Check if the slug is already taken (idempotent retry safety + model
    // duplicate-suggestion safety). If so, fall back to appending the
    // create's sections under the existing page.
    const [existing] = await tx
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.userId, userId),
          eq(wikiPages.scope, 'user'),
          eq(wikiPages.slug, create.slug),
          isNull(wikiPages.tombstonedAt),
        ),
      )
      .limit(1);

    let pageId: string;
    if (existing) {
      pageId = existing.id;
      logger.info(
        { slug: create.slug },
        'research delta: create slug already exists, appending sections instead',
      );
    } else {
      const [page] = await tx
        .insert(wikiPages)
        .values({
          userId,
          scope: 'user',
          type: create.type,
          slug: create.slug,
          parentPageId: parentId,
          title: create.title,
          agentAbstract: create.agent_abstract,
        })
        .returning({ id: wikiPages.id });
      if (!page) throw new Error('research delta: wiki_pages insert returned no row');
      pageId = page.id;
      counters.pagesCreated++;
    }

    // Insert each section. sort_order increments based on what's already there.
    const [maxOrderRow] = await tx
      .select({
        maxOrder: sql<number | null>`max(${wikiSections.sortOrder})`,
      })
      .from(wikiSections)
      .where(eq(wikiSections.pageId, pageId));
    let nextOrder = (maxOrderRow?.maxOrder ?? -1) + 1;
    for (const section of create.sections) {
      await tx.insert(wikiSections).values({
        pageId,
        title: section.title,
        content: section.content,
        sortOrder: nextOrder,
      });
      nextOrder++;
      counters.sectionsAppended++;
    }
  }

  // ── Apply section_appends ──────────────────────────────────────────────
  for (const append of delta.section_appends) {
    // Verify the page exists + belongs to this user (defense in depth —
    // the model could hallucinate a page_id from a different scope).
    const [page] = await tx
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.id, append.page_id),
          eq(wikiPages.userId, userId),
          eq(wikiPages.scope, 'user'),
          isNull(wikiPages.tombstonedAt),
        ),
      )
      .limit(1);
    if (!page) {
      logger.warn(
        { pageId: append.page_id },
        'research delta: skipping section_append with unresolvable page_id',
      );
      continue;
    }

    // Skip if a section with this title already exists on the page (model
    // duplicate-suggestion safety).
    const [existingSection] = await tx
      .select({ id: wikiSections.id })
      .from(wikiSections)
      .where(
        and(
          eq(wikiSections.pageId, append.page_id),
          eq(wikiSections.title, append.title),
          isNull(wikiSections.tombstonedAt),
        ),
      )
      .limit(1);
    if (existingSection) {
      logger.info(
        { pageId: append.page_id, title: append.title },
        'research delta: section title already exists, skipping append',
      );
      continue;
    }

    // Append at the end of the page's sections.
    const [maxOrderRow] = await tx
      .select({ maxOrder: sql<number | null>`max(${wikiSections.sortOrder})` })
      .from(wikiSections)
      .where(eq(wikiSections.pageId, append.page_id));
    const nextOrder = (maxOrderRow?.maxOrder ?? -1) + 1;

    await tx.insert(wikiSections).values({
      pageId: append.page_id,
      title: append.title,
      content: append.content,
      sortOrder: nextOrder,
    });
    counters.sectionsAppended++;
  }

  return counters;
}
