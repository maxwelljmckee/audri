// Stage 3 of upload ingestion — transactional commit of Pro fan-out
// result. Writes to wiki_pages + wiki_sections + wiki_section_history +
// wiki_section_uploads (NOT wiki_section_transcripts).
//
// Lean version of apps/worker/src/ingestion/commit.ts:
//   - No cited_urls (upload pipeline has no live web grounding)
//   - No todo_assignee='assistant' (uploads have no speaker persona)
//   - No agent-scope pass (uploads don't carry agent observations)
//   - No section-merge via Flash (collision → append new section
//     instead; revisit when dogfooding shows merge is needed)
//   - No research-task spawning (tasks always empty per upload prompt)
//
// Everything else mirrors the transcript commit: validation, parent
// resolution, ON CONFLICT-aware page upsert, section keep/update/create/
// tombstone diff, todos sidecar.
//
// Atomic — one Drizzle transaction; either everything lands or nothing.

import {
  and,
  db,
  eq,
  inArray,
  isNull,
  sql,
  todos,
  uploadAttachments,
  wikiLog,
  wikiPages,
  wikiSectionHistory,
  wikiSectionUploads,
  wikiSections,
} from '@audri/shared/db';
import { logger } from '../logger.js';
import type { CandidatePage } from '../ingestion/candidate-pages.js';
import type { ProUploadFanOutResult, UploadSectionRef } from './types.js';

export interface UploadCommitInput {
  userId: string;
  uploadId: string;
  // Per-attachment lifecycle row — we flip status='succeeded' on this
  // at the end of the transaction.
  attachmentId: string;
  fanOut: ProUploadFanOutResult;
  candidatePages: CandidatePage[];
}

export interface UploadCommitResult {
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

export async function commitUploadFanOut(
  input: UploadCommitInput,
): Promise<UploadCommitResult> {
  const { userId, uploadId, attachmentId, fanOut, candidatePages } = input;
  const candidateBySlug = new Map(candidatePages.map((p) => [p.slug, p]));

  const result: UploadCommitResult = {
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
    'upload commit: pro fan-out output',
  );

  await db.transaction(async (tx) => {
    // ── CREATES ────────────────────────────────────────────────────────
    for (const create of fanOut.creates) {
      if (!create.slug || !create.title || !create.type || !create.agent_abstract) {
        logger.warn(
          { create: JSON.stringify(create).slice(0, 300) },
          'upload commit: create missing required field — skipping',
        );
        continue;
      }
      if (!VALID_PAGE_TYPES.has(create.type)) {
        logger.warn(
          { slug: create.slug, type: create.type },
          'upload commit: create has invalid page type — skipping',
        );
        continue;
      }

      // Resolve parent_slug → parent_page_id (best-effort).
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
            'upload commit: slug conflict but no active row — skipping create',
          );
          continue;
        }
        pageId = existing.id;
        isMergeMode = true;
        result.pagesMerged++;
      }

      // Sidecar row for todo-type creates. Skip in merge mode (existing
      // sidecar already there — UNIQUE on page_id would collide).
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
        // Uploads have no speaker — assignee always defaults to user (NULL).
        await tx.insert(todos).values({
          userId,
          pageId,
          parentPageId: todoParentPageId,
          assigneeAgentId: null,
          status: 'todo',
        });
      }

      // Sections — straight INSERT in fresh-create mode; append at end
      // in merge mode (skip Flash-based section merge for v0.3.0).
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
          uploadId,
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
          'upload commit: update missing required field — skipping',
        );
        continue;
      }

      const candidate = candidateBySlug.get(update.slug);
      if (!candidate) {
        logger.warn(
          { slug: update.slug },
          'upload commit: update slug not in candidate set — skipping',
        );
        continue;
      }

      // Hierarchy move (optional). Only when explicitly set.
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

      // Section diff: only when `sections` is present on the update.
      // Absent = move-only metadata update; leave sections alone.
      if (Array.isArray(update.sections)) {
        const r = await applyUpdateSections(tx, {
          pageId: candidate.id,
          uploadId,
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
      summary: `Upload ingest: +${result.pagesCreated} pages, ${result.pagesUpdated} updated, ${result.sectionsCreated} new sections`,
      ref: { uploadId, attachmentId },
    });

    // ── Mark attachment row as succeeded ──────────────────────────────
    await tx
      .update(uploadAttachments)
      .set({ status: 'succeeded', error: null, completedAt: new Date() })
      .where(eq(uploadAttachments.id, attachmentId));
  });

  logger.info({ uploadId, ...result }, 'upload commit: complete');
  return result;
}

// biome-ignore lint/suspicious/noExplicitAny: Drizzle tx type is complex
async function insertSection(
  tx: any,
  args: {
    pageId: string;
    uploadId: string;
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
    await tx.insert(wikiSectionUploads).values({
      sectionId: sec.id,
      uploadId: args.uploadId,
      snippet: snippet.text.slice(0, 1000),
    });
  }
}

interface ApplyUpdateSectionsArgs {
  pageId: string;
  uploadId: string;
  existing: Array<{ id: string }>;
  incoming: UploadSectionRef[];
}

// biome-ignore lint/suspicious/noExplicitAny: Drizzle tx type is complex
async function applyUpdateSections(
  tx: any,
  args: ApplyUpdateSectionsArgs,
): Promise<{ created: number; updated: number; tombstoned: number }> {
  const stats = { created: 0, updated: 0, tombstoned: 0 };

  // Track which existing sections appear in the incoming list — anything
  // not appearing gets tombstoned.
  const keptIds = new Set<string>();

  // Max sort_order on the page (for new sections appended at the end).
  const [maxRow] = await tx
    .select({ max: sql<number>`COALESCE(MAX(${wikiSections.sortOrder}), -1)` })
    .from(wikiSections)
    .where(and(eq(wikiSections.pageId, args.pageId), isNull(wikiSections.tombstonedAt)));
  let nextSortOrder = (maxRow?.max ?? -1) + 1;

  for (const ref of args.incoming) {
    if (ref.id) {
      keptIds.add(ref.id);

      // Update-in-place when content/title provided. Just keep when no
      // body fields present.
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
        // Append new snippets (don't tombstone old junction rows —
        // historical attribution to prior uploads stays).
        for (const snippet of ref.snippets ?? []) {
          if (!snippet.text) continue;
          await tx.insert(wikiSectionUploads).values({
            sectionId: ref.id,
            uploadId: args.uploadId,
            snippet: snippet.text.slice(0, 1000),
          });
        }
        stats.updated++;
      }
    } else {
      // New section on existing page.
      if (!ref.content) continue;
      await insertSection(tx, {
        pageId: args.pageId,
        uploadId: args.uploadId,
        title: ref.title ?? null,
        content: ref.content,
        snippets: ref.snippets ?? [],
        sortOrder: nextSortOrder++,
      });
      stats.created++;
    }
  }

  // Tombstone removed sections.
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
