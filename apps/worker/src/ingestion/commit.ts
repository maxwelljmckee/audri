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
  agentTasks,
  and,
  callTranscripts,
  db,
  eq,
  inArray,
  isNull,
  sql,
  todos,
  wikiLog,
  wikiPages,
  wikiSectionHistory,
  wikiSectionTranscripts,
  wikiSections,
} from '@audri/shared/db';
import { logger } from '../logger.js';
import type { CandidatePage } from './candidate-pages.js';
import type { ProFanOutResult } from './pro-fan-out.js';
import { redactJsonPii } from './redact.js';

export interface CommitInput {
  userId: string;
  transcriptId: string;
  // The active call's agent (persona). Used to resolve `todo_assignee:
  // 'assistant'` → sidecar.assignee_agent_id. Threaded through from
  // tasks/ingestion.ts's job payload.
  agentId: string;
  fanOut: ProFanOutResult;
  candidatePages: CandidatePage[];
}

function truncateForTitle(s: string, max = 60): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > 30 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}

export interface CommitResult {
  pagesCreated: number;
  pagesUpdated: number;
  sectionsCreated: number;
  sectionsUpdated: number;
  sectionsTombstoned: number;
  tasksCreated: number;
}

export async function commitFanOut(input: CommitInput): Promise<CommitResult> {
  const { userId, transcriptId, agentId, fanOut, candidatePages } = input;
  const candidateBySlug = new Map(candidatePages.map((p) => [p.slug, p]));

  const result: CommitResult = {
    pagesCreated: 0,
    pagesUpdated: 0,
    sectionsCreated: 0,
    sectionsUpdated: 0,
    sectionsTombstoned: 0,
    tasksCreated: 0,
  };

  // Diagnostic: dump Pro's exact output before applying so log mining can
  // explain commit zero-counts. Strip later once stable.
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
    'commit: pro fan-out output',
  );

  // Validation set for page types — must match the page_type pgEnum in
  // packages/shared/src/db/schema/enums.ts.
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

  await db.transaction(async (tx) => {
    // ── CREATES ─────────────────────────────────────────────────────────────
    for (const create of fanOut.creates) {
      // Defensive validation — Pro's responseSchema enforces these but real
      // outputs occasionally omit fields anyway. Skip with warn rather than
      // crashing the whole transaction.
      if (!create.slug || !create.title || !create.type || !create.agent_abstract) {
        logger.warn(
          { create: JSON.stringify(create).slice(0, 300) },
          'commit: create missing required field — skipping',
        );
        continue;
      }
      if (!VALID_PAGE_TYPES.has(create.type)) {
        logger.warn(
          { slug: create.slug, type: create.type },
          'commit: create has invalid page type — skipping',
        );
        continue;
      }

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

      // v0.2.1 sidecar — every type='todo' wiki create gets a sidecar row.
      // Status defaults to 'todo'; parent_page_id resolves the optional
      // todo_parent_slug to a wiki page UUID (NULL when absent or unresolvable).
      // Default-to-NULL is load-bearing: per the prompt rules, the model
      // should ONLY emit todo_parent_slug when the transcript explicitly
      // directs association. Anything else stays unassigned ("General").
      if (create.type === 'todo') {
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
          else {
            logger.warn(
              { slug: create.slug, todoParentSlug: create.todo_parent_slug },
              'commit: todo_parent_slug unresolvable — leaving sidecar parent_page_id NULL',
            );
          }
        }
        // Resolve todo_assignee. 'user' (or omitted) → NULL. 'assistant'
        // → the active persona's agent_id. Any other value falls back to
        // NULL with a warn — better defensive default than a broken FK.
        let assigneeAgentId: string | null = null;
        if (create.todo_assignee === 'assistant') {
          assigneeAgentId = agentId;
        } else if (create.todo_assignee && create.todo_assignee !== 'user') {
          logger.warn(
            { slug: create.slug, todoAssignee: create.todo_assignee },
            'commit: unknown todo_assignee value — defaulting to user (NULL)',
          );
        }
        await tx.insert(todos).values({
          userId,
          pageId: pageRow.id,
          parentPageId: todoParentPageId,
          assigneeAgentId,
          status: 'todo',
        });
      }

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
      if (!update.slug || !update.agent_abstract) {
        logger.warn(
          { update: JSON.stringify(update).slice(0, 300) },
          'commit: update missing required field — skipping',
        );
        continue;
      }
      const candidate = candidateBySlug.get(update.slug);
      if (!candidate) {
        logger.warn(
          {
            updateSlug: update.slug,
            availableSlugs: [...candidateBySlug.keys()],
            updatePreview: JSON.stringify(update).slice(0, 300),
          },
          'commit: update slug not in candidate set — skipping',
        );
        continue;
      }

      // Hierarchy move support — three-state parent_slug field on updates:
      //   - omitted (key absent)  → preserve existing parent_page_id
      //   - explicit null         → move to top-level (parent_page_id := null)
      //   - string                → resolve slug, set parent_page_id
      // Only applies when Pro emitted parent_slug, which the prompt restricts
      // to explicit user-directed moves (see pro-fan-out.ts §3 "Hierarchy
      // moves on existing pages").
      let movePatch: { parentPageId: string | null } | null = null;
      if (Object.hasOwn(update, 'parent_slug')) {
        if (update.parent_slug === null) {
          movePatch = { parentPageId: null };
        } else if (typeof update.parent_slug === 'string') {
          const targetSlug = update.parent_slug;
          const [target] = await tx
            .select({ id: wikiPages.id })
            .from(wikiPages)
            .where(
              and(
                eq(wikiPages.userId, userId),
                eq(wikiPages.scope, 'user'),
                eq(wikiPages.slug, targetSlug),
              ),
            )
            .limit(1);
          if (target) {
            movePatch = { parentPageId: target.id };
          } else {
            logger.warn(
              { slug: update.slug, requestedParent: targetSlug },
              'commit: hierarchy move target slug not found — leaving existing parent intact',
            );
          }
        }
      }

      // Update page metadata (agent_abstract, abstract regenerated; parent
      // only when move was directed AND target resolved).
      await tx
        .update(wikiPages)
        .set({
          agentAbstract: update.agent_abstract,
          abstract: update.abstract ?? null,
          ...(movePatch ?? {}),
        })
        .where(eq(wikiPages.id, candidate.id));
      result.pagesUpdated++;

      // Sections is OPTIONAL. When absent, leave existing sections untouched
      // (used for move-only metadata updates). When present, treat the array
      // as the full new state — tombstone any existing sections not listed.
      // See PageUpdate.sections in pro-fan-out.ts for the contract.
      if (update.sections === undefined) {
        continue;
      }

      // Diff sections: { id }=keep, { id, content }=update, { title|content }=new.
      const keptOrUpdatedIds = new Set<string>();

      for (let i = 0; i < update.sections.length; i++) {
        const ref = update.sections[i];
        if (!ref) continue;
        const sortOrder = i;

        if (ref.id && !ref.content) {
          // Keep as-is. Preserve content; only update sort_order if changed.
          keptOrUpdatedIds.add(ref.id);
          await tx.update(wikiSections).set({ sortOrder }).where(eq(wikiSections.id, ref.id));
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

    // Claim-level audit dump. Persist Pro's full structured response (creates,
    // updates, skipped, tasks) on the transcript row, with PII regex-redacted.
    // Server-only — call_transcripts isn't synced to mobile. Used for incident
    // debugging ("why did Pro skip claim X?"). See specs/fan-out-prompt.md
    // and tradeoffs.md → "Pro silently overrides Flash's `proposed_parent_slug`"
    // for the design rationale; redactor lives in ./redact.ts.
    const redactedFanOut = redactJsonPii(fanOut);
    await tx
      .update(callTranscripts)
      .set({
        proFanOutResponse: sql`${JSON.stringify(redactedFanOut)}::jsonb`,
      })
      .where(eq(callTranscripts.id, transcriptId));

    // ── TASKS ───────────────────────────────────────────────────────────────
    // Each extracted research-intent commitment becomes:
    //   1. A tracking todo wiki page under todos/todo
    //   2. An agent_tasks(kind='research') row
    //   3. A Graphile job (added in same tx — no enqueue-before-commit race)
    if (fanOut.tasks.length > 0) {
      // v0.2.1: status buckets dropped. Todos nest directly under the
      // `todos` root; status lives on the sidecar.
      const [todosRoot] = await tx
        .select({ id: wikiPages.id })
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.userId, userId),
            eq(wikiPages.scope, 'user'),
            eq(wikiPages.slug, 'todos'),
            isNull(wikiPages.tombstonedAt),
          ),
        )
        .limit(1);

      if (!todosRoot) {
        logger.warn(
          { userId, taskCount: fanOut.tasks.length },
          'todos root missing — skipping task creation',
        );
      } else {
        for (const task of fanOut.tasks) {
          if (task.kind !== 'research') continue;
          // Placeholder title; the research handler's commit overwrites this
          // with the LLM-generated abbreviated title once the task completes.
          const placeholderTitle = `Research: ${truncateForTitle(task.query)}`;
          const [todoRow] = await tx
            .insert(wikiPages)
            .values({
              userId,
              scope: 'user',
              type: 'todo',
              // Suffix with current ms + a random tail to avoid collisions when
              // ingestion produces several research tasks in the same call.
              slug: `todos/research-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
              parentPageId: todosRoot.id,
              title: placeholderTitle,
              agentAbstract: `Research request: ${task.query}`,
            })
            .returning({ id: wikiPages.id });
          if (!todoRow) continue;

          // Sidecar for the spawned research-tracking todo. Starts as 'todo';
          // research handler's commit flips to 'done' when the task completes
          // (in research/commit.ts, alongside the agent_tasks status update).
          // Assigned to the active persona — Audri is the one who'll deliver
          // the research output back to the user. assignee_agent_id makes
          // that explicit on the Todos surface.
          await tx.insert(todos).values({
            userId,
            pageId: todoRow.id,
            parentPageId: null,
            assigneeAgentId: agentId,
            status: 'todo',
          });

          const [taskRow] = await tx
            .insert(agentTasks)
            .values({
              userId,
              todoPageId: todoRow.id,
              kind: 'research',
              payload: {
                query: task.query,
                ...(task.context_summary ? { context_summary: task.context_summary } : {}),
                source_transcript_id: transcriptId,
              },
              status: 'pending',
            })
            .returning({ id: agentTasks.id });
          if (!taskRow) continue;

          const dispatchPayload = JSON.stringify({ agentTaskId: taskRow.id });
          await tx.execute(sql`
            SELECT graphile_worker.add_job(
              'agent_task_dispatch',
              ${dispatchPayload}::json,
              max_attempts => 2
            )
          `);
          result.tasksCreated++;
        }
      }
    }

    // Mirror onto call_transcripts for quick lookup if needed (no-op for now).
    void callTranscripts;
  });

  return result;
}
