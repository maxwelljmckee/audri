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

import {
  agentOpenItems,
  agents,
  and,
  asc,
  callTranscripts,
  db,
  desc,
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
import { Type, type UsageMetadata } from '@google/genai';
import { recordInferenceUsage } from '../usage/record-inference.js';
import { logger } from '../logger.js';
import type { IngestionTranscriptTurn } from './flash-candidate-retrieval.js';
import { parseGeminiJson } from './parse-gemini-json.js';

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

// One per pending item at call-start. The persona decides what to do with it
// based on whether/how it surfaced in the transcript. Terminal states
// (answered/dismissed) stamp `resolved_at`; intermediate (surfaced/engaged)
// stamp `surfaced_at` if not already set.
interface OpenItemResolution {
  id: string;
  status: 'surfaced' | 'answered' | 'engaged' | 'dismissed';
  rationale?: string;
}

// New candidate items the persona wants to hold for future calls. Inserted
// into agent_open_items with status='pending'. Default priority 5.
interface OpenItemCandidate {
  kind: 'question' | 'info_share';
  topic: string;
  body_text: string;
  priority?: number;
}

interface AgentScopeResult {
  creates: AgentScopeCreate[];
  updates: AgentScopeUpdate[];
  skipped: AgentScopeSkipped[];
  resolutions: OpenItemResolution[];
  new_items: OpenItemCandidate[];
  // Explicit early-return signal. When present, the caller skips the
  // commit transaction entirely — no observation writes, no new open
  // items, no resolutions applied, no wiki_log row. Mirrors the
  // user-scope Flash's `dump` field; same bar (see prompt).
  dump?: { reason: string };
}

// Pending agent_open_items at call-start. Passed into Flash so the persona
// can (a) check whether any surfaced in the transcript (resolution) and (b)
// avoid proposing duplicate new items (dedup via `topic`).
interface PendingItemInput {
  id: string;
  kind: 'question' | 'info_share';
  topic: string;
  body_text: string;
  priority: number;
  created_at: string;
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

# The open-items queue — questions and info-shares you've been holding

You also maintain a per-call queue of OPEN ITEMS — items you (this persona) want to raise with the user. Two kinds:

- **\`question\`** — a gap-filling question. You noticed missing context (something the user mentioned in passing but never elaborated; an area of life you don't yet have any read on; an inconsistency you'd like to resolve). Holds until a future call surfaces it.
- **\`info_share\`** — a proactive enrichment. Something you'd like to introduce to the user — a relevant fact, a connection back to something they cared about, an observation about their notes worth surfacing.

Each call you do TWO things with this queue:

## 1. Resolve pending items

You'll receive a list of pending items in input. For each, decide whether the transcript shows it was addressed, and emit a resolution. Possible statuses:

- **\`answered\`** (question only) — the user gave a substantive answer. The question's gap is filled.
- **\`surfaced\`** (info_share OR question delivered without a clear answer) — you (or this persona's earlier turn) raised the item. Mark surfaced even if the user didn't engage; the item is no longer waiting to be delivered.
- **\`engaged\`** (info_share only) — you raised it AND the user engaged substantively (asked follow-up, expanded, reacted). The info-share landed.
- **\`dismissed\`** — the item is no longer worth holding. Reasons: the user explicitly opted out, the item is now stale (resolved by other context), the question's framing was wrong. Use sparingly.

If a pending item DIDN'T surface in the transcript, OMIT it from \`resolutions\` — it stays pending and will be considered for future calls.

## 2. Propose new candidate items

Reflecting on this call, propose new candidates for the queue. Generation discipline:

- **Specific + anchored.** A good question or info-share names a concrete entity, area, or thread. "What's their relationship to their dad like?" beats "ask about family." Anchor to what the user actually said.
- **Useful for future conversations.** The item should make a FUTURE call go better — not just record curiosity for its own sake.
- **Dedup against pending.** If a pending item already covers the same topic, don't propose a duplicate. (Topic field aids matching.)
- **Don't drain the call dry.** Most calls produce 0–2 new items. A rich call may produce 3–4. More than 5 is suspicious.
- **\`priority\` 0–10.** Default 5. Bump higher (7–8) for time-sensitive items (something they're actively deciding about); lower (3) for nice-to-have curiosity.

\`topic\` is a short label (3–6 words) — used for dedup + UI surface. \`body_text\` is the actual content the live agent will deliver: phrased naturally, as you'd want to hear yourself say it.

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
  ],
  "resolutions": [
    {"id": "<pending item uuid>", "status": "surfaced|answered|engaged|dismissed", "rationale": "<optional short note>"}
  ],
  "new_items": [
    {"kind": "question|info_share", "topic": "<3-6 word label>", "body_text": "<the actual content>", "priority": 5}
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
- Every \`resolutions[].id\` MUST appear in the input pending-items list. Never invent ids.
- \`new_items[].body_text\` is what YOU would say — first-person, conversational. NOT a wiki note about the user.

# Volume guidance

Most calls produce **0-2 observation writes**. A long content-rich call may produce **3-5**. More than 5 is suspicious — you may be over-recording. New items follow the same shape — 0-2 typical, 3-4 for rich calls, more than 5 suspicious.

Empty output is valid. If a call was short, low-substance, or purely action-oriented, return:
{"creates": [], "updates": [], "skipped": [{"reason": "no substantive observations from this call"}], "resolutions": [], "new_items": []}

# Dumping a call

You have one OPTIONAL escape hatch: \`dump: { reason: string }\`. When you emit it, the entire commit transaction skips — no observation writes, no new open items, no resolutions applied, no wiki_log row. The Flash inference still ran (its cost is recorded), but nothing accretes onto your private wiki from this call.

**The bar is HIGH.** Default is to process — even sparse observations have value (your wiki is your only cross-call memory). The dump is the narrow exception for calls that are pure noise.

**DUMP when:**
- The call is mic-test / cancellation noise — "hello hello" and hang-up, two filler turns with no content.
- The transcript is so short and content-free there's nothing to observe behavior FROM. A 5-second "test test bye" reveals no patterns worth recording.
- Total substantive content is zero — even one informative turn is enough to skip the dump.

**DO NOT DUMP when:**
- The user shared anything about themselves, even briefly — emotional state, a preference, a passing mention of someone.
- You'd otherwise emit at least one observation write OR one resolution OR one new item — those signals indicate the call had substance.
- You're uncertain. Ambiguity defaults to processing.

When you DO dump, return: \`{"creates": [], "updates": [], "skipped": [], "resolutions": [], "new_items": [], "dump": {"reason": "..."}}\`. All five regular arrays empty AND \`dump\` present.

When you do NOT dump (the default), omit the \`dump\` key entirely.`;

interface AgentScopeInput {
  transcript: IngestionTranscriptTurn[];
  agentWiki: {
    agent_slug: string;
    persona_summary: string;
    pages: AgentWikiPage[];
  };
  userProfileBrief: { name?: string };
  callMetadata: { started_at: string; ended_at: string; end_reason: string };
  pendingItems: PendingItemInput[];
}

interface RunAgentScopeFlashReturn {
  result: AgentScopeResult;
  usage: UsageMetadata | undefined;
}

async function runAgentScopeFlash(input: AgentScopeInput): Promise<RunAgentScopeFlashReturn> {
  const transcriptWithIds = input.transcript.map((t, i) => ({
    id: `turn-${i}`,
    role: t.role,
    text: t.text,
  }));

  const flat = transcriptWithIds.map((t) => `[turn_id=${t.id}] [${t.role}] ${t.text}`).join('\n');

  // Strip section ids out of the wire format — pass them, but make it visible
  // that they're for update references not for the model to invent.
  const wikiJson = JSON.stringify(input.agentWiki, null, 2);

  const pendingItemsBlock =
    input.pendingItems.length > 0
      ? `# Pending open items at call-start\n${JSON.stringify(input.pendingItems, null, 2)}`
      : '# Pending open items at call-start\n(none — queue is empty)';

  const userMessage = `# Persona summary\n${input.agentWiki.persona_summary}\n\n# User profile brief\n${JSON.stringify(input.userProfileBrief)}\n\n# Call metadata\n${JSON.stringify(input.callMetadata)}\n\n${pendingItemsBlock}\n\n# Your existing private wiki\n${wikiJson}\n\n# Transcript\n\n${flat}`;

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
          resolutions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                status: { type: Type.STRING },
                rationale: { type: Type.STRING, nullable: true },
              },
              required: ['id', 'status'],
            },
          },
          new_items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                kind: { type: Type.STRING },
                topic: { type: Type.STRING },
                body_text: { type: Type.STRING },
                priority: { type: Type.INTEGER, nullable: true },
              },
              required: ['kind', 'topic', 'body_text'],
            },
          },
          dump: {
            type: Type.OBJECT,
            nullable: true,
            properties: { reason: { type: Type.STRING } },
            required: ['reason'],
          },
        },
        required: ['creates', 'updates', 'skipped', 'resolutions', 'new_items'],
      },
      temperature: 0.4,
    },
  });

  const parsed = parseGeminiJson<Partial<AgentScopeResult>>(resp, 'agent-scope-flash');
  const usage = resp.usageMetadata;
  if (!parsed) {
    return {
      result: { creates: [], updates: [], skipped: [], resolutions: [], new_items: [] },
      usage,
    };
  }
  const dump =
    parsed.dump && typeof parsed.dump === 'object' && typeof parsed.dump.reason === 'string'
      ? { reason: parsed.dump.reason }
      : undefined;
  return {
    result: {
      creates: Array.isArray(parsed.creates) ? parsed.creates : [],
      updates: Array.isArray(parsed.updates) ? parsed.updates : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
      resolutions: Array.isArray(parsed.resolutions) ? parsed.resolutions : [],
      new_items: Array.isArray(parsed.new_items) ? parsed.new_items : [],
      dump,
    },
    usage,
  };
}

// Fetch pending agent_open_items for this (user, agent) pair, ranked by
// priority desc then creation. Cap matches the prompt's volume guidance —
// passing too many would (a) overflow the input budget for big queues and
// (b) make the resolution task unwieldy. The Composer (preload.ts) uses its
// own K=5 cap on the call-side; this Flash-side cap is generous to ensure
// resolution can see anything that might have surfaced. Stage-2 manual seed
// keeps things short anyway.
const PENDING_ITEM_FETCH_LIMIT = 20;

async function fetchPendingItems(userId: string, agentId: string): Promise<PendingItemInput[]> {
  const rows = await db
    .select({
      id: agentOpenItems.id,
      kind: agentOpenItems.kind,
      topic: agentOpenItems.topic,
      bodyText: agentOpenItems.bodyText,
      priority: agentOpenItems.priority,
      createdAt: agentOpenItems.createdAt,
    })
    .from(agentOpenItems)
    .where(
      and(
        eq(agentOpenItems.userId, userId),
        eq(agentOpenItems.agentId, agentId),
        eq(agentOpenItems.status, 'pending'),
      ),
    )
    .orderBy(desc(agentOpenItems.priority), desc(agentOpenItems.createdAt))
    .limit(PENDING_ITEM_FETCH_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    topic: r.topic,
    body_text: r.bodyText,
    priority: r.priority,
    created_at: r.createdAt.toISOString(),
  }));
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
    .where(and(inArray(wikiSections.pageId, pageIds), isNull(wikiSections.tombstonedAt)))
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
  pendingItemIds: Set<string>;
}): Promise<{
  pagesCreated: number;
  pagesUpdated: number;
  sectionsCreated: number;
  sectionsUpdated: number;
  sectionsTombstoned: number;
  itemsResolved: number;
  itemsCreated: number;
}> {
  const { userId, agentId, agentRootSlug, transcriptId, result, agentWiki, pendingItemIds } = opts;
  const pageBySlug = new Map(agentWiki.pages.map((p) => [p.slug, p]));

  const counts = {
    pagesCreated: 0,
    pagesUpdated: 0,
    sectionsCreated: 0,
    sectionsUpdated: 0,
    sectionsTombstoned: 0,
    itemsResolved: 0,
    itemsCreated: 0,
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

    // ── OPEN-ITEM RESOLUTIONS ──
    // Apply status transitions to pending items the persona judged surfaced/
    // answered/engaged/dismissed in this transcript. Items NOT in the
    // resolutions list stay pending. We validate each id against the
    // call-start pending set to prevent the model from inventing ids or
    // resolving items it wasn't shown.
    const VALID_STATUSES = new Set(['surfaced', 'answered', 'engaged', 'dismissed']);
    const TERMINAL_STATUSES = new Set(['answered', 'dismissed']);
    const now = new Date();
    for (const r of result.resolutions) {
      if (!r.id || !r.status) continue;
      if (!pendingItemIds.has(r.id)) {
        logger.warn(
          { id: r.id, validIds: [...pendingItemIds] },
          'agent-scope commit: resolution id not in pending set, skipping',
        );
        continue;
      }
      if (!VALID_STATUSES.has(r.status)) {
        logger.warn(
          { id: r.id, status: r.status },
          'agent-scope commit: invalid resolution status',
        );
        continue;
      }
      const isTerminal = TERMINAL_STATUSES.has(r.status);
      await tx
        .update(agentOpenItems)
        .set({
          status: r.status as 'surfaced' | 'answered' | 'engaged' | 'dismissed',
          surfacedAt: sql`COALESCE(${agentOpenItems.surfacedAt}, ${now.toISOString()})`,
          resolvedAt: isTerminal ? now : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentOpenItems.id, r.id),
            eq(agentOpenItems.userId, userId),
            eq(agentOpenItems.agentId, agentId),
          ),
        );
      counts.itemsResolved++;
    }

    // ── NEW OPEN-ITEM CANDIDATES ──
    // Inserted as pending. Hygiene sweep handles staleness; composer reads
    // the queue on subsequent calls.
    const VALID_KINDS = new Set(['question', 'info_share']);
    for (const item of result.new_items) {
      if (!item.kind || !item.topic || !item.body_text) continue;
      if (!VALID_KINDS.has(item.kind)) {
        logger.warn({ kind: item.kind }, 'agent-scope commit: invalid new-item kind');
        continue;
      }
      const priority = Math.max(0, Math.min(10, item.priority ?? 5));
      await tx.insert(agentOpenItems).values({
        userId,
        agentId,
        kind: item.kind,
        topic: item.topic,
        bodyText: item.body_text,
        priority,
        status: 'pending',
      });
      counts.itemsCreated++;
    }

    // wiki_log entry — distinct kind so we can audit agent-scope writes.
    const summary =
      `Agent-scope ingestion: +${counts.pagesCreated} pages, ~${counts.pagesUpdated} pages, ` +
      `+${counts.sectionsCreated} sections, ~${counts.sectionsUpdated} sections, ` +
      `−${counts.sectionsTombstoned} sections, ${result.skipped.length} skipped, ` +
      `+${counts.itemsCreated} open-items, ~${counts.itemsResolved} open-items resolved`;

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
  itemsResolved: number;
  itemsCreated: number;
}> {
  const [agentWiki, pendingItems] = await Promise.all([
    fetchAgentWiki(opts.agentId),
    fetchPendingItems(opts.userId, opts.agentId),
  ]);

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
      itemsResolved: 0,
      itemsCreated: 0,
    };
  }

  const flashReturn = await runAgentScopeFlash({
    transcript: opts.transcript,
    agentWiki,
    userProfileBrief: opts.userFirstName ? { name: opts.userFirstName } : {},
    callMetadata: opts.callMetadata,
    pendingItems,
  });
  const result = flashReturn.result;

  // Best-effort usage row. Fired regardless of commit success — the Flash
  // call cost is incurred at the API boundary, not at commit time.
  await recordInferenceUsage({
    userId: opts.userId,
    agentId: opts.agentId,
    callTranscriptId: opts.transcriptId,
    eventKind: 'agent_scope_ingestion',
    model: FLASH_MODEL,
    usage: flashReturn.usage,
  });

  // Explicit dump from Flash — skip the commit transaction entirely.
  // No observation writes, no new open items, no resolutions applied.
  // Returns with `ran: false` so the caller's logging reflects that the
  // pipeline early-exited; Flash usage is already recorded above.
  if (result.dump) {
    logger.info(
      { reason: result.dump.reason, userId: opts.userId, agentId: opts.agentId },
      'agent-scope: flash dumped call — skipping commit',
    );
    return {
      ran: false,
      pagesCreated: 0,
      pagesUpdated: 0,
      sectionsCreated: 0,
      sectionsUpdated: 0,
      sectionsTombstoned: 0,
      skippedCount: 0,
      itemsResolved: 0,
      itemsCreated: 0,
    };
  }

  const counts = await commitAgentScope({
    userId: opts.userId,
    agentId: opts.agentId,
    agentRootSlug: agentWiki.agent_slug,
    transcriptId: opts.transcriptId,
    result,
    agentWiki,
    pendingItemIds: new Set(pendingItems.map((p) => p.id)),
  });

  return {
    ran: true,
    ...counts,
    skippedCount: result.skipped.length,
  };
}
