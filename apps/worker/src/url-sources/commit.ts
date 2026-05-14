// Stage 3 of url-source ingestion — transactional commit of Pro
// fan-out result. Writes to wiki_pages + wiki_sections +
// wiki_section_history + wiki_section_url_sources.
//
// Structurally mirrors apps/worker/src/uploads/commit.ts. The only
// material difference is the junction table:
//   - uploads commit: wiki_section_uploads
//   - url-sources commit: wiki_section_url_sources
// Plus the attachment-status row writes to url_source_attachments.

import {
  and,
  db,
  eq,
  inArray,
  isNull,
  sql,
  todos,
  urlSourceAttachments,
  wikiLog,
  wikiPages,
  wikiSectionHistory,
  wikiSectionUrlSources,
  wikiSections,
} from '@audri/shared/db';
import { logger } from '../logger.js';
import type { CandidatePage } from '../ingestion/candidate-pages.js';
import type { ProUrlSourceFanOutResult, UrlSourceSectionRef } from './types.js';

export interface UrlSourceCommitInput {
  userId: string;
  urlSourceId: string;
  attachmentId: string;
  fanOut: ProUrlSourceFanOutResult;
  candidatePages: CandidatePage[];
}

export interface UrlSourceCommitResult {
  pagesCreated: number;
  pagesUpdated: number;
  pagesMerged: number;
  sectionsCreated: number;
  sectionsUpdated: number;
  sectionsTombstoned: number;
}

const VALID_PAGE_TYPES = new Set([
  'person',
  'concept',
  'project',
  'place',
  'org',
  'source',
  'event',
  'note',
  'profile',
  'todo',
  'braindump',
]);

export async function commitUrlSourceFanOut(
  input: UrlSourceCommitInput,
): Promise<UrlSourceCommitResult> {
  const { userId, urlSourceId, attachmentId, fanOut, candidatePages } = input;
  const candidateBySlug = new Map(candidatePages.map((p) => [p.slug, p]));

  const result: UrlSourceCommitResult = {
    pagesCreated: 0,
    pagesUpdated: 0,
    pagesMerged: 0,
    sectionsCreated: 0,
    sectionsUpdated: 0,
    sectionsTombstoned: 0,
  };

  logger.info(
    {
      creates: fanOut.creates.map((c) => ({
        slug: c.slug,
        type: c.type,
        sectionCount: c.sections?.length ?? 0,
      })),
      updates: fanOut.updates.map((u) => ({
        slug: u.slug,
        sectionRefCount: u.sections?.length ?? 0,
      })),
      skipped: fanOut.skipped,
      candidateSlugs: [...candidateBySlug.keys()],
    },
    'url-source commit: pro fan-out output',
  );

  await db.transaction(async (tx) => {
    // ── CREATES ────────────────────────────────────────────────────────
    for (const create of fanOut.creates) {
      if (!create.slug || !create.title || !create.type || !create.agent_abstract) {
        logger.warn(
          { create: JSON.stringify(create).slice(0, 300) },
          'url-source commit: create missing required field — skipping',
        );
        continue;
      }
      if (!VALID_PAGE_TYPES.has(create.type)) {
        logger.warn(
          { slug: create.slug, type: create.type },
          'url-source commit: create has invalid page type — skipping',
        );
        continue;
      }

      let parentPageId: string | null = null;
      if (create.parent_slug) {
        const [parent] = await tx
          .select({ id: wikiPages.id })
          .from(wikiPages)
          .where(
            and(
              eq(wikiPages.userId, userId),
              eq(wikiPages.scope, 'user'),
              eq(wikiPages.slug, create.parent_slug),
              isNull(wikiPages.tombstonedAt),
            ),
          )
          .limit(1);
        if (parent) parentPageId = parent.id;
      }

      const inserted = await tx
        .insert(wikiPages)
        .values({
          userId,
          scope: 'user',
          // biome-ignore lint/suspicious/noExplicitAny: type validated above
          type: create.type as any,
          slug: create.slug,
          parentPageId,
          title: create.title,
          agentAbstract: create.agent_abstract,
          abstract: create.abstract ?? null,
        })
        .onConflictDoNothing({
          target: [wikiPages.userId, wikiPages.scope, wikiPages.slug],
        })
        .returning({ id: wikiPages.id });

      let pageId: string;
      let isMergeMode = false;
      if (inserted[0]) {
        pageId = inserted[0].id;
        result.pagesCreated++;
      } else {
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
        if (!existing) {
          logger.warn(
            { slug: create.slug },
            'url-source commit: slug conflict but no active row — skipping create',
          );
          continue;
        }
        pageId = existing.id;
        isMergeMode = true;
        result.pagesMerged++;
      }

      // Sidecar row for todo-type creates. URLs producing todos is
      // unusual but defensible (a how-to article enumerating action
      // steps); the assignee always defaults to user since URLs have
      // no speaker.
      if (!isMergeMode && create.type === 'todo') {
        let todoParentPageId: string | null = null;
        if (create.todo_parent_slug) {
          const [parentForTodo] = await tx
            .select({ id: wikiPages.id })
            .from(wikiPages)
            .where(
              and(
                eq(wikiPages.userId, userId),
                eq(wikiPages.scope, 'user'),
                eq(wikiPages.slug, create.todo_parent_slug),
                isNull(wikiPages.tombstonedAt),
              ),
            )
            .limit(1);
          if (parentForTodo) todoParentPageId = parentForTodo.id;
        }
        await tx.insert(todos).values({
          userId,
          pageId,
          parentPageId: todoParentPageId,
          assigneeAgentId: null,
          status: 'todo',
        });
      }

      let nextSortOrder = 0;
      if (isMergeMode) {
        const [maxRow] = await tx
          .select({ max: sql<number>`COALESCE(MAX(${wikiSections.sortOrder}), -1)` })
          .from(wikiSections)
          .where(and(eq(wikiSections.pageId, pageId), isNull(wikiSections.tombstonedAt)));
        nextSortOrder = (maxRow?.max ?? -1) + 1;
      }

      for (const section of create.sections ?? []) {
        await insertSection(tx, {
          pageId,
          urlSourceId,
          title: section.title ?? null,
          content: section.content,
          snippets: section.snippets ?? [],
          sortOrder: nextSortOrder++,
        });
        result.sectionsCreated++;
      }
    }

    // ── UPDATES ────────────────────────────────────────────────────────
    for (const update of fanOut.updates) {
      if (!update.slug || !update.agent_abstract) {
        logger.warn(
          { update: JSON.stringify(update).slice(0, 300) },
          'url-source commit: update missing required field — skipping',
        );
        continue;
      }

      const candidate = candidateBySlug.get(update.slug);
      if (!candidate) {
        logger.warn(
          { slug: update.slug },
          'url-source commit: update slug not in candidate set — skipping',
        );
        continue;
      }

      let parentPageIdUpdate: string | null | undefined;
      if ('parent_slug' in update) {
        if (update.parent_slug === null) {
          parentPageIdUpdate = null;
        } else if (typeof update.parent_slug === 'string') {
          const [parent] = await tx
            .select({ id: wikiPages.id })
            .from(wikiPages)
            .where(
              and(
                eq(wikiPages.userId, userId),
                eq(wikiPages.scope, 'user'),
                eq(wikiPages.slug, update.parent_slug),
                isNull(wikiPages.tombstonedAt),
              ),
            )
            .limit(1);
          if (parent) parentPageIdUpdate = parent.id;
        }
      }

      await tx
        .update(wikiPages)
        .set({
          agentAbstract: update.agent_abstract,
          abstract: update.abstract ?? null,
          ...(parentPageIdUpdate !== undefined ? { parentPageId: parentPageIdUpdate } : {}),
          updatedAt: new Date(),
        })
        .where(eq(wikiPages.id, candidate.id));
      result.pagesUpdated++;

      if (Array.isArray(update.sections)) {
        const r = await applyUpdateSections(tx, {
          pageId: candidate.id,
          urlSourceId,
          existing: candidate.sections.map((s) => ({ id: s.id })),
          incoming: update.sections,
        });
        result.sectionsCreated += r.created;
        result.sectionsUpdated += r.updated;
        result.sectionsTombstoned += r.tombstoned;
      }
    }

    // ── Wiki log ───────────────────────────────────────────────────────
    await tx.insert(wikiLog).values({
      userId,
      kind: 'ingest',
      summary: `URL ingest: +${result.pagesCreated} pages, ${result.pagesUpdated} updated, ${result.sectionsCreated} new sections`,
      ref: { urlSourceId, attachmentId },
    });

    // ── Mark attachment row as succeeded ──────────────────────────────
    await tx
      .update(urlSourceAttachments)
      .set({ status: 'succeeded', error: null, completedAt: new Date() })
      .where(eq(urlSourceAttachments.id, attachmentId));
  });

  logger.info({ urlSourceId, attachmentId, ...result }, 'url-source commit: complete');
  return result;
}

// biome-ignore lint/suspicious/noExplicitAny: Drizzle tx type is complex
async function insertSection(
  tx: any,
  args: {
    pageId: string;
    urlSourceId: string;
    title: string | null;
    content: string;
    snippets: Array<{ text: string }>;
    sortOrder: number;
  },
): Promise<void> {
  const [sec] = await tx
    .insert(wikiSections)
    .values({
      pageId: args.pageId,
      title: args.title,
      content: args.content,
      sortOrder: args.sortOrder,
    })
    .returning({ id: wikiSections.id });
  if (!sec) return;
  await tx.insert(wikiSectionHistory).values({
    sectionId: sec.id,
    content: args.content,
    editedBy: 'ai',
  });
  for (const snippet of args.snippets) {
    if (!snippet.text) continue;
    await tx.insert(wikiSectionUrlSources).values({
      sectionId: sec.id,
      urlSourceId: args.urlSourceId,
      snippet: snippet.text.slice(0, 1000),
    });
  }
}

interface ApplyUpdateSectionsArgs {
  pageId: string;
  urlSourceId: string;
  existing: Array<{ id: string }>;
  incoming: UrlSourceSectionRef[];
}

// biome-ignore lint/suspicious/noExplicitAny: Drizzle tx type is complex
async function applyUpdateSections(
  tx: any,
  args: ApplyUpdateSectionsArgs,
): Promise<{ created: number; updated: number; tombstoned: number }> {
  const stats = { created: 0, updated: 0, tombstoned: 0 };
  const keptIds = new Set<string>();

  const [maxRow] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${wikiSections.sortOrder}), -1)` })
    .from(wikiSections)
    .where(and(eq(wikiSections.pageId, args.pageId), isNull(wikiSections.tombstonedAt)));
  let nextSortOrder = (maxRow?.max ?? -1) + 1;

  for (const ref of args.incoming) {
    if (ref.id) {
      keptIds.add(ref.id);

      if (ref.content !== undefined || ref.title !== undefined) {
        const setPatch: Record<string, unknown> = { updatedAt: new Date() };
        if (ref.content !== undefined) setPatch.content = ref.content;
        if (ref.title !== undefined) setPatch.title = ref.title;

        await tx.update(wikiSections).set(setPatch).where(eq(wikiSections.id, ref.id));

        if (ref.content !== undefined) {
          await tx.insert(wikiSectionHistory).values({
            sectionId: ref.id,
            content: ref.content,
            editedBy: 'ai',
          });
        }
        for (const snippet of ref.snippets ?? []) {
          if (!snippet.text) continue;
          await tx.insert(wikiSectionUrlSources).values({
            sectionId: ref.id,
            urlSourceId: args.urlSourceId,
            snippet: snippet.text.slice(0, 1000),
          });
        }
        stats.updated++;
      }
    } else {
      if (!ref.content) continue;
      await insertSection(tx, {
        pageId: args.pageId,
        urlSourceId: args.urlSourceId,
        title: ref.title ?? null,
        content: ref.content,
        snippets: ref.snippets ?? [],
        sortOrder: nextSortOrder++,
      });
      stats.created++;
    }
  }

  const idsToTombstone = args.existing.map((s) => s.id).filter((id) => !keptIds.has(id));
  if (idsToTombstone.length > 0) {
    await tx
      .update(wikiSections)
      .set({ tombstonedAt: new Date() })
      .where(
        and(
          inArray(wikiSections.id, idsToTombstone),
          isNull(wikiSections.tombstonedAt),
        ),
      );
    stats.tombstoned = idsToTombstone.length;
  }

  return stats;
}
