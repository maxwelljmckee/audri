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
  wikiSectionUrls,
  wikiSections,
} from '@audri/shared/db';
import { logger } from '../logger.js';
import type { CandidatePage } from './candidate-pages.js';
import type { ProFanOutResult } from './pro-fan-out.js';
import { redactJsonPii } from './redact.js';
import { mergeSectionContent } from './section-merge.js';

export interface CommitInput {
  userId: string;
  transcriptId: string;
  // The active call's agent (persona). Used to resolve `todo_assignee:
  // 'assistant'` → sidecar.assignee_agent_id. Threaded through from
  // tasks/ingestion.ts's job payload.
  agentId: string;
  fanOut: ProFanOutResult;
  candidatePages: CandidatePage[];
  // External URLs Audri cited via googleSearch grounding during the call.
  // Used to validate `cited_urls` on section writes — Pro's prompt rule
  // requires verbatim URIs from this list, but we re-check here so a
  // hallucinated URL never becomes a wiki_section_urls row. Sourced from
  // call_transcripts.tool_calls; passed in by tasks/ingestion.ts.
  groundingSources?: Array<{ uri: string; title?: string; domain?: string }>;
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
  // Bumped when a PageCreate hit an existing slug and was routed into
  // merge mode instead of failing. The page already existed; we wrote
  // additional sections (or merged) onto it.
  pagesMerged: number;
  sectionsCreated: number;
  sectionsUpdated: number;
  // Bumped each time a merge call rewrote an existing section body
  // because the create produced a section with a matching title.
  sectionsMerged: number;
  sectionsTombstoned: number;
  tasksCreated: number;
}

export async function commitFanOut(input: CommitInput): Promise<CommitResult> {
  const { userId, transcriptId, agentId, fanOut, candidatePages } = input;

  // Index grounding sources by URI for fast validation + snippet lookup
  // when writing wiki_section_urls rows. Pro is instructed to cite only
  // URIs that appear in the input list verbatim; the defensive check
  // here filters anything that slipped past the prompt rule.
  const groundingByUri = new Map<string, { title?: string; domain?: string }>();
  for (const g of input.groundingSources ?? []) {
    if (g.uri) groundingByUri.set(g.uri, { title: g.title, domain: g.domain });
  }
  const candidateBySlug = new Map(candidatePages.map((p) => [p.slug, p]));

  const result: CommitResult = {
    pagesCreated: 0,
    pagesUpdated: 0,
    pagesMerged: 0,
    sectionsCreated: 0,
    sectionsUpdated: 0,
    sectionsMerged: 0,
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

      // Page upsert. ON CONFLICT (user_id, scope, slug) DO NOTHING — if
      // the slug already exists, fall through to merge mode against the
      // existing page rather than crashing the transaction. Slug
      // collisions happen most often on partial-retry (some pages
      // already landed before a failure) and on cross-call ingestion of
      // the same topic (e.g. user calls about "Social Technology" twice).
      const inserted = await tx
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
        // Slug exists. Look up the existing page; preserve its metadata
        // (title / agent_abstract / abstract / parent) — the assumption
        // is that the existing copy already represents the user's wiki
        // state; we're additively merging new content onto it, not
        // overwriting what's there.
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
            'commit: slug conflict but no active existing row (tombstoned?) — skipping create',
          );
          continue;
        }
        pageId = existing.id;
        isMergeMode = true;
        result.pagesMerged++;
        logger.info(
          { slug: create.slug, pageId },
          'commit: slug exists — merge mode (existing metadata preserved)',
        );
      }

      // v0.2.1 sidecar — every type='todo' wiki create gets a sidecar row.
      // Status defaults to 'todo'; parent_page_id resolves the optional
      // todo_parent_slug to a wiki page UUID (NULL when absent or unresolvable).
      // Default-to-NULL is load-bearing: per the prompt rules, the model
      // should ONLY emit todo_parent_slug when the transcript explicitly
      // directs association. Anything else stays unassigned ("General").
      //
      // Skip in merge mode — if the existing todo page was already in the
      // wiki, its sidecar row already exists; duplicating would collide
      // on (page_id) which is the unique key on `todos`.
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
          pageId,
          parentPageId: todoParentPageId,
          assigneeAgentId,
          status: 'todo',
        });
      }

      // Section-by-section commit. In fresh-create mode, every section is
      // a straight INSERT. In merge mode, a section whose title matches
      // an existing non-tombstoned section on this page triggers a Flash
      // merge call (preserves the existing content + folds the new content
      // in coherently) rather than colliding on `wiki_sections_page_title_idx`.
      // Null-title sections always insert (the partial unique index
      // excludes them).
      //
      // sort_order for merged section inserts: append at end so we don't
      // collide with existing rows that already used sort_orders 0..N.
      let nextAppendSortOrder = 0;
      if (isMergeMode) {
        const [maxRow] = await tx
          .select({ max: sql<number>`COALESCE(MAX(${wikiSections.sortOrder}), -1)` })
          .from(wikiSections)
          .where(and(eq(wikiSections.pageId, pageId), isNull(wikiSections.tombstonedAt)));
        nextAppendSortOrder = (maxRow?.max ?? -1) + 1;
      }

      for (let i = 0; i < create.sections.length; i++) {
        const section = create.sections[i];
        if (!section) continue;

        // Try merge if (a) we're in merge mode, (b) the new section has a
        // title, (c) an active section with that title exists on this page.
        let existingSection: { id: string; content: string } | undefined;
        if (isMergeMode && section.title) {
          const found = await tx
            .select({ id: wikiSections.id, content: wikiSections.content })
            .from(wikiSections)
            .where(
              and(
                eq(wikiSections.pageId, pageId),
                eq(wikiSections.title, section.title),
                isNull(wikiSections.tombstonedAt),
              ),
            )
            .limit(1);
          existingSection = found[0];
        }

        if (existingSection) {
          // Merge via Flash (best-effort; falls back to dated-append on
          // failure — see section-merge.ts). NOTE: this call happens
          // inside the open transaction. Tx-hold time grows with the
          // number of merges in a commit; at our scale (rare, small N)
          // this is acceptable. Revisit if it becomes a connection-pool
          // problem.
          const merged = await mergeSectionContent(
            {
              pageTitle: create.title,
              sectionTitle: section.title ?? null,
              existingContent: existingSection.content,
              incomingContent: section.content,
            },
            { userId, agentId, transcriptId },
          );

          await tx
            .update(wikiSections)
            .set({ content: merged.content })
            .where(eq(wikiSections.id, existingSection.id));

          await tx.insert(wikiSectionHistory).values({
            sectionId: existingSection.id,
            content: merged.content,
            editedBy: 'ai',
          });

          for (const snip of section.snippets ?? []) {
            await tx.insert(wikiSectionTranscripts).values({
              sectionId: existingSection.id,
              transcriptId,
              turnId: snip.turn_id,
              snippet: snip.text,
            });
          }
          for (const url of section.cited_urls ?? []) {
            const meta = groundingByUri.get(url);
            if (!meta) {
              logger.warn(
                { url, sectionId: existingSection.id },
                'commit: cited_url not in grounding sources — skipping',
              );
              continue;
            }
            await tx.insert(wikiSectionUrls).values({
              sectionId: existingSection.id,
              url,
              snippet: meta.title ?? meta.domain ?? '',
            });
          }

          result.sectionsMerged++;
          continue;
        }

        // No collision — insert as new section. In merge mode, sort_order
        // appends after existing sections; in fresh mode, sort_order
        // matches the declared index (today's behavior).
        const sortOrder = isMergeMode ? nextAppendSortOrder++ : i;
        const [sectionRow] = await tx
          .insert(wikiSections)
          .values({
            pageId,
            title: section.title ?? null,
            content: section.content,
            sortOrder,
          })
          .returning({ id: wikiSections.id });
        if (!sectionRow) continue;

        result.sectionsCreated++;

        await tx.insert(wikiSectionHistory).values({
          sectionId: sectionRow.id,
          content: section.content,
          editedBy: 'ai',
        });

        for (const snip of section.snippets ?? []) {
          await tx.insert(wikiSectionTranscripts).values({
            sectionId: sectionRow.id,
            transcriptId,
            turnId: snip.turn_id,
            snippet: snip.text,
          });
        }

        for (const url of section.cited_urls ?? []) {
          const meta = groundingByUri.get(url);
          if (!meta) {
            logger.warn(
              { url, sectionId: sectionRow.id },
              'commit: cited_url not in grounding sources — skipping',
            );
            continue;
          }
          await tx.insert(wikiSectionUrls).values({
            sectionId: sectionRow.id,
            url,
            snippet: meta.title ?? meta.domain ?? '',
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
          for (const url of ref.cited_urls ?? []) {
            const meta = groundingByUri.get(url);
            if (!meta) {
              logger.warn(
                { url, sectionId: ref.id },
                'commit: cited_url not in grounding sources — skipping',
              );
              continue;
            }
            await tx.insert(wikiSectionUrls).values({
              sectionId: ref.id,
              url,
              snippet: meta.title ?? meta.domain ?? '',
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
          for (const url of ref.cited_urls ?? []) {
            const meta = groundingByUri.get(url);
            if (!meta) {
              logger.warn(
                { url, sectionId: sectionRow.id },
                'commit: cited_url not in grounding sources — skipping',
              );
              continue;
            }
            await tx.insert(wikiSectionUrls).values({
              sectionId: sectionRow.id,
              url,
              snippet: meta.title ?? meta.domain ?? '',
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
      `≈${result.pagesMerged} pages merged, +${result.sectionsCreated} sections, ` +
      `~${result.sectionsUpdated} sections, ≈${result.sectionsMerged} sections merged, ` +
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
