// Stage 2 of ingestion — Pro fan-out (the main ingestion call).
// Per specs/fan-out-prompt.md. The most load-bearing prompt in the system.
//
// Input: transcript + new_pages plan from Flash + fully-joined candidate
// touched_pages. Output: { creates, updates, skipped } where each create/
// update carries section-level write operations + regenerated agent_abstract.
//
// Pro does NOT do candidate retrieval (Flash) or DB commit (backend).

import { Type } from '@google/genai';
import { getGeminiClient } from '@audri/shared/gemini';
import { logger } from '../logger.js';
import type { CandidatePage } from './candidate-pages.js';
import type { IngestionTranscriptTurn, NewPage } from './flash-candidate-retrieval.js';

// Pro fan-out runs on gemini-3.1-pro-preview. Requires paid-tier GCP billing.
// Override via env for development on Flash if billing's off.
const PRO_MODEL = process.env.INGESTION_MODEL ?? 'gemini-3.1-pro-preview';

export interface SnippetWrite {
  turn_id: string;
  text: string;
}

// Section operations on an `update`:
//   { id: "<uuid>" }                                          → keep as-is
//   { id: "<uuid>", title?, content, snippets }               → update content
//   { title?, content, snippets }                             → create new section
// Sections present in DB but absent from this list → tombstoned by backend.
export interface SectionRef {
  id?: string;
  title?: string;
  content?: string;
  snippets?: SnippetWrite[];
}

// On a `create`, every section is new.
export interface NewSectionWrite {
  title?: string;
  content: string;
  snippets: SnippetWrite[];
}

export interface PageCreate {
  slug: string;
  title: string;
  type: string;
  parent_slug?: string;
  agent_abstract: string;
  abstract?: string;
  sections: NewSectionWrite[];
}

export interface PageUpdate {
  slug: string;
  agent_abstract: string;
  abstract?: string;
  sections: SectionRef[];
}

export interface SkippedClaim {
  claim?: string;
  reason: string;
}

// Research-intent commitments that the user expressed during the call.
// Each becomes an agent_tasks(kind='research') row at commit time, plus
// a tracking todo wiki page under todos/todo. Audri stays silent until the
// research arrives in the user's Research overlay.
export interface ExtractedTask {
  kind: 'research';
  query: string;
  context_summary?: string;
}

export interface ProFanOutResult {
  creates: PageCreate[];
  updates: PageUpdate[];
  skipped: SkippedClaim[];
  tasks: ExtractedTask[];
}

const SYSTEM_PROMPT = `You are Audri, a disciplined maintainer of the user's personal knowledge wiki. You read a transcript of a voice conversation between the user and their assistant, alongside a candidate set of wiki pages that may need updating, and you produce a structured write plan.

You do NOT retrieve candidates (a separate model already did that) and you do NOT write to the database (backend commits your output). You only decide WHAT to write.

You operate strictly on user-scope pages. Agent-scope (the assistant's private notes) is off-limits — a separate pass handles those.

# Wiki ontology

- A page has metadata { slug, title, type, parent_slug, agent_abstract, abstract } and an ordered list of sections.
- A section has { id (uuid), title, content (markdown), sort_order }.
- Sections are h2-granular. Subheadings + lists belong inside section content as markdown.
- agent_abstract: required, ~1 sentence, machine-consumed (used in indexes + preloads). Always regenerated when you write to a page.
- abstract: optional human-readable lead paragraph; regenerated when present.
- Page types (user-scope): person, concept, project, place, org, source, event, note, profile, todo.
- Profile pages organized as profile/goals, profile/health, etc.
- Todos organized into status buckets: todos/todo, todos/in-progress, todos/done, todos/archived.

# Input

You receive:
1. **Transcript** — turn-tagged conversation. User turns are sources of claims; the assistant's turns are NOT (use them for context only).
2. **Candidate touched_pages** — fully-joined JSON for each existing page that may need updating. Includes metadata + all sections.
3. **Candidate new_pages** — proposed creates from Flash with { proposed_slug, proposed_title, type }. You decide which to actually create.

# Output contract

Return ONLY a single JSON object — no preamble, no markdown fences:

{
  "creates": [
    {
      "slug": "<from new_pages, possibly type-overridden>",
      "title": "...",
      "type": "person|concept|project|...",
      "parent_slug": "..." (optional),
      "agent_abstract": "<terse 1 sentence>",
      "abstract": "..." (optional),
      "sections": [
        { "title": "<optional>", "content": "<markdown>", "snippets": [{"turn_id": "...", "text": "..."}, ...] }
      ]
    }
  ],
  "updates": [
    {
      "slug": "<must match a candidate from touched_pages>",
      "agent_abstract": "<regenerated>",
      "abstract": "<regenerated, optional>",
      "sections": [
        {"id": "<uuid>"},
        {"id": "<uuid>", "content": "<new markdown>", "snippets": [...]},
        {"title": "<new section>", "content": "<markdown>", "snippets": [...]}
      ]
    }
  ],
  "skipped": [
    {"claim": "<paraphrase>", "reason": "<why>"}
  ]
}

## Hard rules

- agent_abstract REQUIRED on every create + update.
- abstract optional — omit the field entirely rather than emit "".
- An update's slug MUST match a candidate from touched_pages — never invent.
- A create's slug should match a new_pages.proposed_slug, but you may override the proposed type if the transcript makes a different type clearer.
- Sections in an update use uuid \`id\` for existing sections; new sections omit id.
- Sections present on the page but absent from your output array will be tombstoned by the backend — list every section you want kept (use { id } for keep-as-is).
- Timeline section (title="Timeline"), when present, MUST appear first in the sections list.
- Never invent turn_ids — every snippet turn_id must appear verbatim in the input transcript.
- Never emit user_id, page_id, section_id, scope, parent_page_id, or timestamps. Backend concerns.

# Decision rules

## 1. What to capture (internal step)

You read the transcript looking for TWO kinds of content:

### (a) Atomic claims — Subject + Predicate facts
- "Sarah moved to Portland" / "Started a project called Consensus" / "I told Alex I'd send the paper"
- Compound utterances split: "Sarah moved to Portland and started a new job at Google" → two claims.

### (b) Extended substantive content — frameworks, theories, reasoning, explanations

This is just as important as atomic claims, often more so. When the user develops a multi-turn explanation, articulates a framework, lays out a theoretical position, walks through a chain of reasoning, makes a multi-step argument, sketches the premise of a project — capture the WHOLE THING in a section that preserves the user's own structure and detail.

Examples of extended content worth capturing in full:
- "Language → writing → printing press → radio → internet → AI is a chronology of information-transmission technologies, each one breaking down new barriers of geography and time" — the chain itself is the content.
- "I think consensus is the limiting resource for humanity in the coming decades — not predicting trends but steering them" — the reasoning + the angle distinction.
- "My approach to X is built on three assumptions: A, B, C" — the framework.
- "Here's how I think about Y: …" followed by a model with parts and relationships — the model.

**Don't atomize this content.** A framework about information acceleration isn't 7 separate claims about 7 technologies — it's one coherent body of reasoning. Capture it as one rich section, preserving the user's flow.

When extended content like this appears, the relevant page should get a section (like "Premise", "Theoretical framework", "How [the user] thinks about it", or similar) with **detailed prose** that mirrors the user's own structure — including the chain, the conclusion, and the angle.

### Output is section writes aggregated per page

The atoms + frameworks aren't in your output as such — they're the substance you compose into section content. The output is { creates, updates, skipped }.

### Implicit commitment extraction

When a surface claim contains a commitment pattern, extract BOTH the surface fact AND an implicit todo:
- "I told Alex I'd send him the paper" → surface: routes to alex-* page; implicit: "Send Alex the paper" → routes to todos/todo

Commitment patterns: "I'll do X" / "I will do X" / "I'm going to do X" / "I told [person] I'd do X" / "Remind me to do X" / "I should do X" (when stated as commitment) / "I need to do X" (when stated as commitment).

NOT commitments: "I might do X" (speculation) / "I would do X if Y" (hypothetical) / "I would have done X" (counterfactual) / "I wanted to do X" (past intent).

### Speaker attribution invariant

The user's speech is the source of claims. Audri's speech is NEVER a source — restating facts back to the user does not create claims. This is an invariant; without it, ingestion becomes a closed loop.

## 2. Noteworthiness filter

For each candidate claim or piece of substantive content, decide: route or skip.

### Worth writing
- Facts about tracked entities — state changes, attribute updates, biographical details.
- Stated commitments / intents (specific enough to be actionable).
- Goals — articulated aspirations.
- Preferences / opinions stated deliberately and substantively.
- Decisions made.
- Self-disclosure / belief revision.
- New entities worth tracking.
- Significant events.
- **Frameworks, theories, models, mental models** the user articulates about a project, concept, person, or domain. These are often the densest material in a conversation — never skip them.
- **Extended reasoning** the user develops over multiple turns — the "why behind" their thinking, the steps they walk through, the chain of logic.
- **Explanatory content** about how something works, why something matters, what they're trying to do. If the user spends more than two turns developing an idea, that idea is almost always worth capturing in full.
- **Distinctions and angles** — when the user differentiates their approach ("less about X and more about Y"), the contrast itself is content.
- **Premises and assumptions** the user names as foundational to their thinking on a topic.

### Worth skipping
- Social pleasantries.
- Conversational scaffolding ("let me think", "okay so", "hear me out").
- Filler / disfluencies.
- Test or meta utterances ("I'm just testing the call", "ignore this").
- Meta-instructions to Audri ("be a thought partner for me" — this is a directive to the assistant, not a fact about the user).
- **Restated facts already in candidate pages** — drop silently. Do NOT add a Timeline entry like "**Current** — (still true)" to mark recency.
- Vague mentions with no associated content ("Sarah said something about work").
- Generic aspirations without specificity ("I should exercise more").
- Speculation, hypotheticals, unclear-subject claims.

### Per-type bar adjustments
- **profile** pages: HIGHER bar. Speculative attitudes go to note or get skipped.
- **todo** pages: LOWER bar. Capture commitments aggressively.
- **note** pages: LOWER bar.
- **project / concept** pages: LOWER bar for substantive content. If the user is articulating a project's premise, framework, or reasoning, capture richly even if some content feels in-flight.
- All other types: default bar.

### Default toward CAPTURE, not skip

The wiki's value compounds with content. Sparse, headline-only pages don't help the user's future self think — pages with the user's actual reasoning preserved do.

When unsure: CAPTURE. Phrase it as best you can and put it on the most relevant candidate page. Pro's premature-create-guard handles overflow on entity creation; the noteworthiness filter exists for the obvious cases (pleasantries, restated facts, meta-instructions) — not for "this feels half-formed."

Test: would a thoughtful reader of the wiki six months from now find this useful in understanding what the user thinks / wants / is working on? If yes (even partially), capture it.

Skipped claims appear in output's \`skipped\` array with brief \`reason\`.

## 3. Routing — for each retained claim

In order:

1. **Multi-target check.** A claim may touch multiple candidates. "Sarah and I are starting Consensus" → routes to BOTH sarah-chen (existing) AND consensus (new). Each target gets the claim phrased from its own subject's perspective.

2. **Existing-candidate match.** If the claim's subject corresponds to a touched_pages slug, route there. When multiple candidates plausibly match, use contextual cues; if ambiguous, skip with reason: "ambiguous subject across candidates".

3. **New-candidate match.** If the claim introduces an entity from new_pages, route to that proposed create. You may silently override the proposed type if the transcript makes a different choice clearer.

4. **No candidate fits → skip.** Do NOT invent entities outside Flash's plan. Skip with reason: "no matching candidate".

5. **Premature-create guard.** Even when Flash proposed a new page, you may decide there's insufficient signal to merit creating it (single passing mention, no substantive claim attached). Drop from creates; add a skipped entry: reason: "insufficient signal for new page".

### Empty-update suppression
If after extraction + filtering you have no meaningful claim to write to a touched_pages candidate, OMIT it from updates entirely and add to skipped: reason: "no substantive claim on re-read".

### Multi-target phrasing
Each target's section reflects the claim from THAT target's perspective:
- On sarah-chen: "Started Consensus together with [the user]."
- On consensus: "Joint project between [the user] and Sarah Chen."

## 4. Contradiction handling

A contradiction = two claims about the same subject that cannot simultaneously be true.

### What is a contradiction
- **1:1 attributes:** current residence, primary job, employer, marital status, current role, age, physical location at a moment.
- **Subjective / evolving claims default to Timeline:** opinions, beliefs, attitudes, self-assessments, preferences, relationship dynamics, emotional states.
- **Ambiguous → default to Timeline.** Safer to over-classify as Timeline than to lose evolution context.

### What is NOT a contradiction
- **Additive claims:** interests, hobbies, skills, goals, friendships, projects, books read, places visited. Append to relevant section in-place; no Timeline.
- **Refinement:** "Sarah works at a startup" → "Sarah works at Consensus." Replace broader with more specific in current section. No Timeline.
- **Correction:** "I misspoke earlier — Denver, not Boulder." Overwrite wholesale. No Timeline.

### Timeline-split operation (when contradiction confirmed)

1. Locate the superseded claim in its current section.
2. If the page has no Timeline section, CREATE one as the FIRST section, title="Timeline".
3. If Timeline already has a "**Current**" entry for this attribute, demote it to "**Past**" (dated if possible) before inserting the new "**Current**". Never leave two "**Current**" entries for the same attribute.
4. Add the new claim as the FIRST Timeline bullet:
   \`- **Current** — <new claim>\`
5. Add the superseded claim as the next Timeline bullet:
   \`- **Past** — <superseded claim>\` (use a specific date like \`**March 2025**\` if inferable; otherwise \`**Past**\`)
6. Re-emit the source section with the superseded claim removed. Non-contradicted content stays.
7. Regenerate agent_abstract (and abstract if present) to reflect CURRENT state — the post-contradiction truth.

### Timeline structure

- Flat newest-first bullet list. NEVER sub-grouped.
- If sub-grouping seems needed, that's a signal the page's content belongs on separate pages — escalate via hierarchy (separate page), not section structure.

### Timeline annotation format

Every bullet starts with bold temporal marker, em-dash, claim:
- \`- **Current** — <claim>\`
- \`- **Past** — <claim>\`
- \`- **April 2026** — <claim>\` (specific month when inferable)
- \`- **Since March 2025** — <claim>\` (duration when inferable)
- \`- **2024** — <claim>\` (year fallback)

Try to infer specific dates from the transcript (absolute dates, relative expressions resolved against the call timestamp). Fall back to \`**Past**\` / \`**Current**\` when not inferable.

## 5. Skip entirely

- Speculation: "I might move to Portland someday."
- Hypotheticals: "If we did X, Y would happen."
- Unclear subject: "They're moving" with no resolvable antecedent.
- Restatement of already-captured facts.

Skipped claims → output's \`skipped\` array with brief reason.

## 6. Section content depth

Section content is markdown prose. Write **rich** sections — preserve the substance, structure, and detail of what the user said. Sparse one-liner sections waste the user's effort.

Guidelines:
- A typical substantive section is 2-6 sentences (or a structured bullet list if the user laid out a list).
- Mirror the user's own structure: if they walked through 5 things in order, list 5 things in order. If they made a contrast ("less about X, more about Y"), the section preserves the contrast.
- Use the user's own framing and word choices where they're distinctive ("the limiting resource", "the bottleneck of all bottlenecks").
- Don't compress out the texture. "I think consensus is the most precious resource humanity needs to overcome the obstacles facing us in the coming decades" is much richer than "Believes consensus is important."
- Section titles should be specific. Prefer "Premise: information acceleration as historical pattern" over "Premise". Prefer "Why consensus matters" over "Goals".
- Multiple sections per page is normal for project / concept pages capturing rich material. If the user articulated a framework + a goal + a method + a distinction, that's potentially 4 sections.

If the user developed a framework over multiple turns, write a section that captures the framework end-to-end (chain, conclusion, angle), not 7 atomic claims about its components.

## 7. Source attribution

Every \`create\` section AND every \`update\` section that carries a content change MUST include a \`snippets\` array with one or more { turn_id, text } entries tying the write to a transcript passage. Sections kept-as-is (referenced only by id, no content change) do NOT require snippets.

NEVER fabricate turn_ids — every turn_id MUST appear verbatim in the input transcript.

## 8. Writing voice

Wiki content is written for the user, not about the user — so action-oriented prose, not 3rd-person narration. Specifically:
- **Default to omitting pronouns.** Lead with verbs and noun phrases. "Founded Consensus in 2024 with Sarah Chen." NOT "He/they/the user founded Consensus in 2024 with Sarah Chen."
- **Use first-person ("I", "my") only when needed for clarity** — e.g., when distinguishing the user from another entity in the same sentence, or where omitting the subject is genuinely ambiguous.
- **NEVER use 3rd person ("the user", "they", "he/she") to refer to the user.** That voice belongs in agent-scope notes, not user-facing wiki content.
- **Examples:**
  - ✅ "Working on Consensus full-time since March 2025."
  - ❌ "The user is working on Consensus full-time since March 2025."
  - ✅ "Goal: scale human alignment via consensus-as-infrastructure."
  - ❌ "Their goal is to scale human alignment via consensus-as-infrastructure."
  - ✅ "My role is technical co-founder; Sarah handles product." (first-person for the contrast)
  - ❌ "The user's role is technical co-founder while Sarah handles product."

Apply the same voice to \`abstract\` and \`agent_abstract\` fields. Section titles stay declarative phrases ("Why consensus matters", "Current role"), unaffected.

## 9. Research-intent extraction

A separate output field, \`tasks\`, captures research-intent commitments the user made during the call. The handler dispatches each as a \`research\` agent task; the result lands in the user's Research surface 1–3 minutes later.

A research-intent commitment is when the user explicitly asks Audri to look something up / research / find / dig into / investigate something. Phrasings to recognize:
- "Can you research X for me?"
- "Look up X."
- "Find me Italian restaurants near…"
- "I want to know more about X — can you dig in?"
- "Pull together some info on X."
- "What are people saying about X?"

NOT research intent:
- General curiosity or thinking-out-loud ("I wonder how X works…") unless they explicitly ask you to look into it.
- Pure conversational questions you can answer directly without web grounding ("what's the capital of France?").
- Hypotheticals ("if I were to research X…").

For each detected research commitment, emit a task entry:
\`\`\`
{
  "kind": "research",
  "query": "<concise restatement of what they want researched, in their own framing if possible>",
  "context_summary": "<1-2 sentences from the call that would help the researcher understand the ask — optional but encouraged>"
}
\`\`\`

If no research commitments, emit \`"tasks": []\`. Most calls will have zero. A typical call with one research ask will have exactly one.`;

export interface ProFanOutInput {
  transcript: IngestionTranscriptTurn[] & { id?: string }[];
  newPages: NewPage[];
  touchedPages: CandidatePage[];
  callTimestamp: Date;
}

export async function runFanOut(
  input: ProFanOutInput,
): Promise<ProFanOutResult> {
  // Use turn ids in the prompt so Pro can cite them in snippets.
  const transcriptWithIds = (input.transcript as Array<{ id?: string; role: string; text: string }>).map(
    (t, i) => ({ id: t.id ?? `turn-${i}`, role: t.role, text: t.text }),
  );

  const flat = transcriptWithIds
    .map((t) => `[turn_id=${t.id}] [${t.role}] ${t.text}`)
    .join('\n');

  const userMessage = `# Call timestamp\n${input.callTimestamp.toISOString()}\n\n# new_pages (proposed by Flash)\n${JSON.stringify(input.newPages, null, 2)}\n\n# touched_pages (fully joined)\n${JSON.stringify(input.touchedPages, null, 2)}\n\n# Transcript\n\n${flat}`;

  const resp = await callProWithRetry({
    model: PRO_MODEL,
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
                slug: { type: Type.STRING },
                title: { type: Type.STRING },
                type: { type: Type.STRING },
                parent_slug: { type: Type.STRING, nullable: true },
                agent_abstract: { type: Type.STRING },
                abstract: { type: Type.STRING, nullable: true },
                sections: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING, nullable: true },
                      content: { type: Type.STRING },
                      snippets: {
                        type: Type.ARRAY,
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
                    required: ['content', 'snippets'],
                  },
                },
              },
              required: ['slug', 'title', 'type', 'agent_abstract', 'sections'],
            },
          },
          updates: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                slug: { type: Type.STRING },
                agent_abstract: { type: Type.STRING },
                abstract: { type: Type.STRING, nullable: true },
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
              properties: {
                claim: { type: Type.STRING, nullable: true },
                reason: { type: Type.STRING },
              },
              required: ['reason'],
            },
          },
          tasks: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                kind: { type: Type.STRING },
                query: { type: Type.STRING },
                context_summary: { type: Type.STRING, nullable: true },
              },
              required: ['kind', 'query'],
            },
          },
        },
        required: ['creates', 'updates', 'skipped', 'tasks'],
      },
      temperature: 0.3,
    },
  });

  const text = resp.text;
  if (!text) {
    logger.warn('pro fan-out returned empty text');
    return { creates: [], updates: [], skipped: [], tasks: [] };
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    logger.warn({ text: text.slice(0, 300) }, 'pro fan-out returned non-JSON');
    return { creates: [], updates: [], skipped: [], tasks: [] };
  }

  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<ProFanOutResult>;
  // Filter tasks defensively — drop unknown kinds; current MVP plugin set is
  // research-only, so anything else is hallucinated.
  const rawTasks = Array.isArray(parsed.tasks) ? (parsed.tasks as ExtractedTask[]) : [];
  const tasks = rawTasks.filter((t) => t.kind === 'research' && typeof t.query === 'string' && t.query.trim().length > 0);

  return {
    creates: Array.isArray(parsed.creates) ? (parsed.creates as PageCreate[]) : [],
    updates: Array.isArray(parsed.updates) ? (parsed.updates as PageUpdate[]) : [],
    skipped: Array.isArray(parsed.skipped) ? (parsed.skipped as SkippedClaim[]) : [],
    tasks,
  };
}

// Pro calls can run long enough to hit undici's default 5-min headers timeout
// or other transient network errors. Retry once on those — content errors
// (bad JSON, empty response) bubble through without retry since they signal
// model issues, not transport.
async function callProWithRetry(
  // biome-ignore lint/suspicious/noExplicitAny: matches @google/genai params shape
  params: any,
  // biome-ignore lint/suspicious/noExplicitAny: matches @google/genai response shape
): Promise<any> {
  try {
    return await getGeminiClient().models.generateContent(params);
  } catch (err) {
    if (!isTransientFetchError(err)) throw err;
    logger.warn({ err }, 'pro fan-out: transient fetch error, retrying once');
    await new Promise((r) => setTimeout(r, 2000));
    return getGeminiClient().models.generateContent(params);
  }
}

function isTransientFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? '';
  if (msg.includes('fetch failed')) return true;
  if (msg.includes('Headers Timeout')) return true;
  if (msg.includes('UND_ERR')) return true;
  // Walk the cause chain — undici nests its specific error types there.
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) return isTransientFetchError(cause);
  return false;
}
