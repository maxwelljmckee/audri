// Stage 3 of ingestion — transactional commit of Pro fan-out result.
//
// All writes happen in ONE Drizzle transaction:
//   - new pages (creates) → wiki_pages + wiki_sections + wiki_section_history
//     + wiki_section_transcripts
//   - updates → wiki_pages metadata regen, per-section keep/update/create,
//     tombstone removed sections, history snapshots on change
//   - one wiki_log row marking the ingest event
//
// Atomic — if anything fails, nothing commits.

import {
  and,
  callTranscripts,
  db,
  eq,
  inArray,
  isNull,
  sql,
  wikiLog,
  wikiPages,
  wikiSectionHistory,
  wikiSectionTranscripts,
  wikiSections,
} from '@audri/shared/db';
import type { CandidatePage } from './candidate-pages.js';
import type { ProFanOutResult } from './pro-fan-out.js';

export interface CommitInput {
  userId: string;
  transcriptId: string;
  fanOut: ProFanOutResult;
  candidatePages: CandidatePage[];
}

export interface CommitResult {
  pagesCreated: number;
  pagesUpdated: number;
  sectionsCreated: number;
  sectionsUpdated: number;
  sectionsTombstoned: number;
}

export async function commitFanOut(input: CommitInput): Promise<CommitResult> {
  const { userId, transcriptId, fanOut, candidatePages } = input;
  const candidateBySlug = new Map(candidatePages.map((p) => [p.slug, p]));

  const result: CommitResult = {
    pagesCreated: 0,
    pagesUpdated: 0,
    sectionsCreated: 0,
    sectionsUpdated: 0,
    sectionsTombstoned: 0,
  };

  await db.transaction(async (tx) => {
    // ── CREATES ─────────────────────────────────────────────────────────────
    for (const create of fanOut.creates) {
      // Resolve parent_slug → parent_page_id (best effort; null if not found).
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
            ),
          )
          .limit(1);
        if (parent) parentPageId = parent.id;
      }

      const [pageRow] = await tx
        .insert(wikiPages)
        .values({
          userId,
          scope: 'user',
          // biome-ignore lint/suspicious/noExplicitAny: Pro's type validated by responseSchema
          type: create.type as any,
          slug: create.slug,
          parentPageId,
          title: create.title,
          agentAbstract: create.agent_abstract,
          abstract: create.abstract ?? null,
        })
        .returning({ id: wikiPages.id });
      if (!pageRow) continue;

      result.pagesCreated++;

      // Sections, in declared order.
      for (let i = 0; i < create.sections.length; i++) {
        const section = create.sections[i];
        if (!section) continue;
        const [sectionRow] = await tx
          .insert(wikiSections)
          .values({
            pageId: pageRow.id,
            title: section.title ?? null,
            content: section.content,
            sortOrder: i,
          })
          .returning({ id: wikiSections.id });
        if (!sectionRow) continue;

        result.sectionsCreated++;

        // Initial history snapshot.
        await tx.insert(wikiSectionHistory).values({
          sectionId: sectionRow.id,
          content: section.content,
          editedBy: 'ai',
        });

        // Source-attribution junctions.
        for (const snip of section.snippets ?? []) {
          await tx.insert(wikiSectionTranscripts).values({
            sectionId: sectionRow.id,
            transcriptId,
            turnId: snip.turn_id,
            snippet: snip.text,
          });
        }
      }
    }

    // ── UPDATES ─────────────────────────────────────────────────────────────
    for (const update of fanOut.updates) {
      const candidate = candidateBySlug.get(update.slug);
      if (!candidate) continue; // Pro hallucinated a slug; skip.

      // Update page metadata (agent_abstract, abstract — re-generated).
      await tx
        .update(wikiPages)
        .set({
          agentAbstract: update.agent_abstract,
          abstract: update.abstract ?? null,
        })
        .where(eq(wikiPages.id, candidate.id));
      result.pagesUpdated++;

      // Diff sections: { id }=keep, { id, content }=update, { title|content }=new.
      const keptOrUpdatedIds = new Set<string>();

      for (let i = 0; i < update.sections.length; i++) {
        const ref = update.sections[i];
        if (!ref) continue;
        const sortOrder = i;

        if (ref.id && !ref.content) {
          // Keep as-is. Preserve content; only update sort_order if changed.
          keptOrUpdatedIds.add(ref.id);
          await tx
            .update(wikiSections)
            .set({ sortOrder })
            .where(eq(wikiSections.id, ref.id));
          continue;
        }

        if (ref.id && ref.content !== undefined) {
          // Update existing section.
          keptOrUpdatedIds.add(ref.id);

          await tx
            .update(wikiSections)
            .set({
              ...(ref.title !== undefined ? { title: ref.title || null } : {}),
              content: ref.content,
              sortOrder,
            })
            .where(eq(wikiSections.id, ref.id));

          await tx.insert(wikiSectionHistory).values({
            sectionId: ref.id,
            content: ref.content,
            editedBy: 'ai',
          });

          for (const snip of ref.snippets ?? []) {
            await tx.insert(wikiSectionTranscripts).values({
              sectionId: ref.id,
              transcriptId,
              turnId: snip.turn_id,
              snippet: snip.text,
            });
          }
          result.sectionsUpdated++;
          continue;
        }

        if (ref.content !== undefined) {
          // New section on this page.
          const [sectionRow] = await tx
            .insert(wikiSections)
            .values({
              pageId: candidate.id,
              title: ref.title ?? null,
              content: ref.content,
              sortOrder,
            })
            .returning({ id: wikiSections.id });
          if (!sectionRow) continue;

          await tx.insert(wikiSectionHistory).values({
            sectionId: sectionRow.id,
            content: ref.content,
            editedBy: 'ai',
          });

          for (const snip of ref.snippets ?? []) {
            await tx.insert(wikiSectionTranscripts).values({
              sectionId: sectionRow.id,
              transcriptId,
              turnId: snip.turn_id,
              snippet: snip.text,
            });
          }
          result.sectionsCreated++;
        }
      }

      // Tombstone any existing sections not in the kept/updated set.
      const existingIds = candidate.sections.map((s) => s.id);
      const toTombstone = existingIds.filter((id) => !keptOrUpdatedIds.has(id));
      if (toTombstone.length > 0) {
        await tx
          .update(wikiSections)
          .set({ tombstonedAt: new Date() })
          .where(and(inArray(wikiSections.id, toTombstone), isNull(wikiSections.tombstonedAt)));
        result.sectionsTombstoned += toTombstone.length;
      }
    }

    // ── LOG ─────────────────────────────────────────────────────────────────
    const touchedSlugs = [
      ...fanOut.creates.map((c) => c.slug),
      ...fanOut.updates.map((u) => u.slug),
    ];
    const summary =
      `Ingestion: +${result.pagesCreated} pages, ~${result.pagesUpdated} pages, ` +
      `+${result.sectionsCreated} sections, ~${result.sectionsUpdated} sections, ` +
      `−${result.sectionsTombstoned} sections, ${fanOut.skipped.length} claims skipped`;

    await tx.insert(wikiLog).values({
      userId,
      kind: 'ingest',
      ref: sql`${JSON.stringify({ transcriptId, slugs: touchedSlugs })}::jsonb`,
      summary,
    });

    // Mirror onto call_transcripts for quick lookup if needed (no-op for now).
    void callTranscripts;
  });

  return result;
}
