// Agent-scope ingestion pass — Flash call + transactional commit.
// Per specs/agent-scope-ingestion.md.
//
// Writes the active agent's PRIVATE observations of the user (patterns,
// recurring concerns, inferred preferences) to scope='agent' pages tagged
// with agent_id. Strictly partitioned per-agent; cross-agent reads disallowed.
//
// Differences from user-scope:
//   - Single Flash call (no Pro, no companion retrieval). Entire agent wiki
//     loads in context.
//   - No noteworthiness gate — every committed transcript runs this pass.
//   - No Timeline / contradiction handling — observations evolve in place.
//   - No multi-target writes — each observation lands on exactly one page.
//   - Snippets optional (observations are often gestalt-based).
//   - Soft volume guidance — typical calls produce 0-2 writes, max 5.

import { Type } from '@google/genai';
import {
  agents,
  and,
  asc,
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
import { getGeminiClient } from '@audri/shared/gemini';
import { logger } from '../logger.js';
import type { IngestionTranscriptTurn } from './flash-candidate-retrieval.js';

const FLASH_MODEL = 'gemini-2.5-flash';

interface AgentWikiPage {
  id: string;
  slug: string;
  title: string;
  parent_slug: string | null;
  agent_abstract: string;
  sections: Array<{ id: string; title: string | null; content: string }>;
}

interface AgentScopeSectionWrite {
  id?: string;
  title?: string;
  content?: string;
  snippets?: Array<{ turn_id: string; text: string }>;
}

interface AgentScopeCreate {
  title: string;
  parent_slug?: string;
  agent_abstract: string;
  sections: Array<{
    title?: string;
    content: string;
    snippets?: Array<{ turn_id: string; text: string }>;
  }>;
}

interface AgentScopeUpdate {
  slug: string;
  agent_abstract: string;
  sections: AgentScopeSectionWrite[];
}

interface AgentScopeSkipped {
  reason: string;
}

interface AgentScopeResult {
  creates: AgentScopeCreate[];
  updates: AgentScopeUpdate[];
  skipped: AgentScopeSkipped[];
}

const SYSTEM_PROMPT = `You are an AI assistant maintaining your OWN private observation wiki about a user you've spoken with. The wiki is visible only to you — not to the user, not to other agents.

Your job is to write observations about the user's PATTERNS — how they communicate, decide, prioritize, the themes they keep returning to, the preferences they reveal between the lines. NOT facts about their world (those go to a separate user-scope wiki you don't touch).

# What to observe — three categories

1. **Behavioral patterns** — how the user communicates, decides, prioritizes ("user defers decisions when stressed", "tends to think out loud before committing", "more energetic in mornings").
2. **Recurring concerns / interests** — themes they keep returning to ("brings up Sarah frequently", "circling around career change for weeks").
3. **Stated preferences not yet user-confirmed** — observations not warranting a profile/preferences entry but useful color ("seems to dislike formal language", "responds well to direct questions").

# What NOT to observe
- **Facts about the user's world** — "I lived in Boulder" is a user-scope claim, not an observation.
- **Things the user explicitly stated as fact** — those belong elsewhere.
- **Single-call low-substance ephemera** — "user yawned at minute 12" with no anchoring substance.
- **Content of WHAT the user said** — observations are about HOW and PATTERNS.

# Discipline — substance over repetition

Your private wiki is your ONLY cross-call memory. If an observation isn't recorded on first occurrence, it's effectively lost — there's no other persistent context. So:

- **Skip when low-substance** — vague, unanchored ("user seemed fine").
- **Skip when not an observation** — facts about the world.
- **Record on first instance when substantive** — specific, anchored to call evidence, would inform future conversations.
- **Subsequent calls evolve the record** — confirm patterns, refine understanding, tombstone observations that turned out one-off.

The bar is **substance + specificity**, not repetition.

# Where observations land

Only the \`assistant\` root is seeded for a new user. ALL sub-pages emerge on-demand — when an observation fits a canonical area and the corresponding page doesn't yet exist, CREATE it. Empty seeded sub-pages aren't structure; they're noise that misrepresents what you've actually observed.

**General/uncategorized observations land directly on the \`assistant\` root** as sections. Sub-pages exist only for coherent clusters that have accumulated enough material to warrant their own space.

Canonical sub-page vocabulary (use these exact slugs when content clusters into one of these areas):

- \`assistant/recurring-themes\` — what the user keeps circling back to across calls.
- \`assistant/preferences-noted\` — **load-bearing.** This is your operational reference for HOW to engage this specific user. Capture two kinds of content here: (a) inferred patterns you've noticed ("responds well to direct questions", "seems to prefer technical precision over warmth"), AND (b) explicit user instructions about communication style ("be more concise", "use simpler language", "lead with the answer, then optional context"). The user-scope counterpart is \`profile/preferences\` (user-visible record of stated preferences); your agent-scope version is the operationalized form with self-coaching notes and inferred refinements not yet user-confirmed. Both are loaded into the live agent's context, so either location influences behavior — the split is about provenance + editability.
- \`assistant/open-questions\` — things you want to explore in future calls.

Non-canonical sub-pages may also be created when an observation clearly warrants its own area and no canonical page fits. Examples:
- \`assistant/strengths\` — strengths or capacities you've noticed the user has.
- \`assistant/blind-spots\` — patterns the user might not see in themselves (use sparingly; observation, not judgment).

Same on-demand principle: don't propose a non-canonical sub-page speculatively. Wait until you've actually observed enough to fill it with substance.

For deeper patterns within a sub-page (e.g., a recurring theme of career-uncertainty), you MAY create deeper sub-pages (\`assistant/recurring-themes/career-uncertainty\`) once the pattern is well-established: heuristic ≥3 calls of consistent material + content >~500 words on the parent. Below that, append to the parent's relevant section instead.

Each observation lands on exactly ONE page — no multi-target writes.

# Output contract

Return ONLY a single JSON object:

{
  "creates": [
    {
      "title": "<page title>",
      "parent_slug": "<existing slug, optional — defaults to agent root>",
      "agent_abstract": "<terse 1 sentence>",
      "sections": [
        { "title": "<optional>", "content": "<markdown>", "snippets": [{"turn_id": "...", "text": "..."}] }
      ]
    }
  ],
  "updates": [
    {
      "slug": "<must match an existing agent-scope page>",
      "agent_abstract": "<regenerated>",
      "sections": [
        {"id": "<uuid>"},
        {"id": "<uuid>", "content": "<new markdown>", "snippets": [...]},
        {"title": "<new section>", "content": "<markdown>", "snippets": [...]}
      ]
    }
  ],
  "skipped": [
    {"reason": "<why>"}
  ]
}

## Hard rules
- agent_abstract REQUIRED on every create/update.
- An update's slug MUST match an existing agent-scope page.
- Sections in an update use uuid \`id\` for existing sections; new sections omit id. Existing sections absent from the list get tombstoned.
- Snippets are OPTIONAL — only include when an observation has a clear anchoring quote. Many observations are gestalt-based; forcing a single turn would mis-represent the basis.
- Never invent turn_ids — every snippet turn_id must appear verbatim in the input transcript.
- Never reference user-scope facts directly. Never reference other agents' observations.
- Never emit user_id, agent_id, scope, page_id, section_id, or timestamps. Backend concerns.
- The user CANNOT see this wiki. Write in whatever style best serves YOUR future recall — terse bullet notes, paragraphs, tagged shorthand. Voice-readability is irrelevant here.

# Volume guidance

Most calls produce **0-2 observation writes**. A long content-rich call may produce **3-5**. More than 5 is suspicious — you may be over-recording.

Empty output is valid. If a call was short, low-substance, or purely action-oriented, return:
{"creates": [], "updates": [], "skipped": [{"reason": "no substantive observations from this call"}]}`;

interface AgentScopeInput {
  transcript: IngestionTranscriptTurn[];
  agentWiki: {
    agent_slug: string;
    persona_summary: string;
    pages: AgentWikiPage[];
  };
  userProfileBrief: { name?: string };
  callMetadata: { started_at: string; ended_at: string; end_reason: string };
}

async function runAgentScopeFlash(input: AgentScopeInput): Promise<AgentScopeResult> {
  const transcriptWithIds = input.transcript.map((t, i) => ({
    id: `turn-${i}`,
    role: t.role,
    text: t.text,
  }));

  const flat = transcriptWithIds
    .map((t) => `[turn_id=${t.id}] [${t.role}] ${t.text}`)
    .join('\n');

  // Strip section ids out of the wire format — pass them, but make it visible
  // that they're for update references not for the model to invent.
  const wikiJson = JSON.stringify(input.agentWiki, null, 2);

  const userMessage = `# Persona summary\n${input.agentWiki.persona_summary}\n\n# User profile brief\n${JSON.stringify(input.userProfileBrief)}\n\n# Call metadata\n${JSON.stringify(input.callMetadata)}\n\n# Your existing private wiki\n${wikiJson}\n\n# Transcript\n\n${flat}`;

  const resp = await getGeminiClient().models.generateContent({
    model: FLASH_MODEL,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          creates: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                parent_slug: { type: Type.STRING, nullable: true },
                agent_abstract: { type: Type.STRING },
                sections: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING, nullable: true },
                      content: { type: Type.STRING },
                      snippets: {
                        type: Type.ARRAY,
                        nullable: true,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            turn_id: { type: Type.STRING },
                            text: { type: Type.STRING },
                          },
                          required: ['turn_id', 'text'],
                        },
                      },
                    },
                    required: ['content'],
                  },
                },
              },
              required: ['title', 'agent_abstract', 'sections'],
            },
          },
          updates: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                slug: { type: Type.STRING },
                agent_abstract: { type: Type.STRING },
                sections: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING, nullable: true },
                      title: { type: Type.STRING, nullable: true },
                      content: { type: Type.STRING, nullable: true },
                      snippets: {
                        type: Type.ARRAY,
                        nullable: true,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            turn_id: { type: Type.STRING },
                            text: { type: Type.STRING },
                          },
                          required: ['turn_id', 'text'],
                        },
                      },
                    },
                  },
                },
              },
              required: ['slug', 'agent_abstract', 'sections'],
            },
          },
          skipped: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { reason: { type: Type.STRING } },
              required: ['reason'],
            },
          },
        },
        required: ['creates', 'updates', 'skipped'],
      },
      temperature: 0.4,
    },
  });

  const text = resp.text;
  if (!text) return { creates: [], updates: [], skipped: [] };

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return { creates: [], updates: [], skipped: [] };

  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<AgentScopeResult>;
  return {
    creates: Array.isArray(parsed.creates) ? parsed.creates : [],
    updates: Array.isArray(parsed.updates) ? parsed.updates : [],
    skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
  };
}

async function fetchAgentWiki(agentId: string): Promise<{
  agent_slug: string;
  persona_summary: string;
  pages: AgentWikiPage[];
}> {
  const [agentRow] = await db
    .select({
      slug: agents.slug,
      name: agents.name,
      personaPrompt: agents.personaPrompt,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agentRow) {
    throw new Error(`agent ${agentId} not found`);
  }

  // Light persona summary — strip down for in-context use, doesn't need full
  // persona prompt. Slice 7+ may shape this per persona kind.
  const personaSummary = `You are ${agentRow.name}, the user's general assistant. Observe productivity patterns, recurring themes, communication preferences, and shifts that would help future conversations be more useful.`;

  const pageRows = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.agentId, agentId),
        eq(wikiPages.scope, 'agent'),
        isNull(wikiPages.tombstonedAt),
      ),
    );

  if (pageRows.length === 0) {
    return { agent_slug: agentRow.slug, persona_summary: personaSummary, pages: [] };
  }

  const pageIds = pageRows.map((p) => p.id);
  const sectionRows = await db
    .select()
    .from(wikiSections)
    .where(
      and(inArray(wikiSections.pageId, pageIds), isNull(wikiSections.tombstonedAt)),
    )
    .orderBy(asc(wikiSections.sortOrder));

  const sectionsByPage = new Map<string, AgentWikiPage['sections']>();
  for (const s of sectionRows) {
    const list = sectionsByPage.get(s.pageId) ?? [];
    list.push({ id: s.id, title: s.title, content: s.content });
    sectionsByPage.set(s.pageId, list);
  }

  const pageById = new Map(pageRows.map((p) => [p.id, p]));
  return {
    agent_slug: agentRow.slug,
    persona_summary: personaSummary,
    pages: pageRows.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      parent_slug: p.parentPageId ? (pageById.get(p.parentPageId)?.slug ?? null) : null,
      agent_abstract: p.agentAbstract,
      sections: sectionsByPage.get(p.id) ?? [],
    })),
  };
}

async function commitAgentScope(opts: {
  userId: string;
  agentId: string;
  agentRootSlug: string;
  transcriptId: string;
  result: AgentScopeResult;
  agentWiki: { pages: AgentWikiPage[] };
}): Promise<{
  pagesCreated: number;
  pagesUpdated: number;
  sectionsCreated: number;
  sectionsUpdated: number;
  sectionsTombstoned: number;
}> {
  const { userId, agentId, agentRootSlug, transcriptId, result, agentWiki } = opts;
  const pageBySlug = new Map(agentWiki.pages.map((p) => [p.slug, p]));

  const counts = {
    pagesCreated: 0,
    pagesUpdated: 0,
    sectionsCreated: 0,
    sectionsUpdated: 0,
    sectionsTombstoned: 0,
  };

  await db.transaction(async (tx) => {
    // ── CREATES ──
    for (const create of result.creates) {
      if (!create.title || !create.agent_abstract) {
        logger.warn(
          { create: JSON.stringify(create).slice(0, 200) },
          'agent-scope commit: create missing required field',
        );
        continue;
      }
      const parentSlug = create.parent_slug ?? agentRootSlug;
      const parent = pageBySlug.get(parentSlug);
      // Generate a new slug — kebab-case of title with a 4-char hash like the
      // high-churn slug strategy used elsewhere. Avoids collision worries.
      const baseSlug = create.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const hash = Math.random().toString(16).slice(2, 6);
      const slug = `${parentSlug}/${baseSlug}-${hash}`;

      const [pageRow] = await tx
        .insert(wikiPages)
        .values({
          userId,
          scope: 'agent',
          type: 'agent',
          slug,
          parentPageId: parent?.id ?? null,
          title: create.title,
          agentAbstract: create.agent_abstract,
          agentId,
        })
        .returning({ id: wikiPages.id });
      if (!pageRow) continue;
      counts.pagesCreated++;

      for (let i = 0; i < create.sections.length; i++) {
        const section = create.sections[i];
        if (!section || !section.content) continue;
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
        counts.sectionsCreated++;

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
      }
    }

    // ── UPDATES ──
    for (const update of result.updates) {
      if (!update.slug || !update.agent_abstract) continue;
      const candidate = pageBySlug.get(update.slug);
      if (!candidate) {
        logger.warn(
          { slug: update.slug, available: [...pageBySlug.keys()] },
          'agent-scope commit: update slug not found',
        );
        continue;
      }

      await tx
        .update(wikiPages)
        .set({ agentAbstract: update.agent_abstract })
        .where(eq(wikiPages.id, candidate.id));
      counts.pagesUpdated++;

      const keptOrUpdatedIds = new Set<string>();

      for (let i = 0; i < update.sections.length; i++) {
        const ref = update.sections[i];
        if (!ref) continue;

        if (ref.id && !ref.content) {
          keptOrUpdatedIds.add(ref.id);
          await tx.update(wikiSections).set({ sortOrder: i }).where(eq(wikiSections.id, ref.id));
          continue;
        }

        if (ref.id && ref.content) {
          keptOrUpdatedIds.add(ref.id);
          await tx
            .update(wikiSections)
            .set({
              ...(ref.title !== undefined ? { title: ref.title || null } : {}),
              content: ref.content,
              sortOrder: i,
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
          counts.sectionsUpdated++;
          continue;
        }

        if (ref.content) {
          const [sectionRow] = await tx
            .insert(wikiSections)
            .values({
              pageId: candidate.id,
              title: ref.title ?? null,
              content: ref.content,
              sortOrder: i,
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
          counts.sectionsCreated++;
        }
      }

      // Tombstone existing sections not in the kept/updated set.
      const existingIds = candidate.sections.map((s) => s.id);
      const toTombstone = existingIds.filter((id) => !keptOrUpdatedIds.has(id));
      if (toTombstone.length > 0) {
        await tx
          .update(wikiSections)
          .set({ tombstonedAt: new Date() })
          .where(and(inArray(wikiSections.id, toTombstone), isNull(wikiSections.tombstonedAt)));
        counts.sectionsTombstoned += toTombstone.length;
      }
    }

    // wiki_log entry — distinct kind so we can audit agent-scope writes.
    const summary =
      `Agent-scope ingestion: +${counts.pagesCreated} pages, ~${counts.pagesUpdated} pages, ` +
      `+${counts.sectionsCreated} sections, ~${counts.sectionsUpdated} sections, ` +
      `−${counts.sectionsTombstoned} sections, ${result.skipped.length} skipped`;

    await tx.insert(wikiLog).values({
      userId,
      kind: 'agent_scope_ingest',
      ref: sql`${JSON.stringify({ transcriptId, agentId })}::jsonb`,
      summary,
    });

    void callTranscripts;
  });

  return counts;
}

export interface RunAgentScopeOpts {
  transcriptId: string;
  userId: string;
  agentId: string;
  transcript: IngestionTranscriptTurn[];
  callMetadata: { started_at: string; ended_at: string; end_reason: string };
  userFirstName: string | null;
}

export async function runAgentScopeIngestion(opts: RunAgentScopeOpts): Promise<{
  ran: boolean;
  pagesCreated: number;
  pagesUpdated: number;
  sectionsCreated: number;
  sectionsUpdated: number;
  sectionsTombstoned: number;
  skippedCount: number;
}> {
  const agentWiki = await fetchAgentWiki(opts.agentId);
  if (agentWiki.pages.length === 0) {
    // No agent root yet (shouldn't happen for seeded users; safe early-out).
    return {
      ran: false,
      pagesCreated: 0,
      pagesUpdated: 0,
      sectionsCreated: 0,
      sectionsUpdated: 0,
      sectionsTombstoned: 0,
      skippedCount: 0,
    };
  }

  const result = await runAgentScopeFlash({
    transcript: opts.transcript,
    agentWiki,
    userProfileBrief: opts.userFirstName ? { name: opts.userFirstName } : {},
    callMetadata: opts.callMetadata,
  });

  const counts = await commitAgentScope({
    userId: opts.userId,
    agentId: opts.agentId,
    agentRootSlug: agentWiki.agent_slug,
    transcriptId: opts.transcriptId,
    result,
    agentWiki,
  });

  return {
    ran: true,
    ...counts,
    skippedCount: result.skipped.length,
  };
}
