// Stage 1 of ingestion — Flash candidate retrieval.
// Per specs/flash-retrieval-prompt.md.
//
// Reads transcript + compact wiki index, emits candidate set:
//   - touched_pages: existing pages that may need updates
//   - new_pages: proposed new pages to create
// Empty arrays = noteworthiness gate fails → Pro never runs.
//
// Bias: recall over precision. Pro can cheaply skip over-flagged candidates;
// it CANNOT recover anything Flash misses.

import { Type } from '@google/genai';
import { getGeminiClient } from '@audri/shared/gemini';
import { logger } from '../logger.js';
import type { WikiIndexEntry } from './wiki-index.js';

const FLASH_MODEL = 'gemini-2.5-flash';

export interface TouchedPage {
  slug: string;
}

export interface NewPage {
  proposed_slug: string;
  proposed_title: string;
  type: string;
}

export interface FlashCandidateResult {
  touched_pages: TouchedPage[];
  new_pages: NewPage[];
}

export interface IngestionTranscriptTurn {
  role: 'user' | 'agent';
  text: string;
}

const SYSTEM_PROMPT = `You are Audri, a fast and recall-biased candidate-finder for an ingestion pipeline. You read a turn-tagged voice transcript and a compact index of the user's existing knowledge wiki, and you emit which pages might need updates plus any new pages worth creating.

You do NOT extract claims, write to the wiki, evaluate which exact facts to record, or detect contradictions. A separate model (Pro) does all of that, operating on the candidate set you produce.

# Wiki ontology

The wiki is a graph of pages. Each page has:
- slug: stable kebab-case identifier (e.g. "sarah-chen", "consensus")
- title: human-readable
- type: one of person | concept | project | place | org | source | event | note | profile | todo
- parent_slug: optional parent in the hierarchy
- agent_abstract: terse one-sentence machine summary of what the page is about

Profile pages: organized as profile/goals, profile/health, profile/work, etc.
Todos: organized into status buckets — todos/todo (pending), todos/in-progress, todos/done, todos/archived. Individual todos live under those buckets.

# Output contract

Return ONLY a single JSON object — no preamble, no explanation, no markdown fences:

{
  "touched_pages": [{"slug": "..."}, ...],
  "new_pages": [{"proposed_slug": "...", "proposed_title": "...", "type": "..."}, ...]
}

Hard rules:
- Both keys ALWAYS present. Empty arrays are valid.
- touched_pages[].slug MUST appear verbatim in the input index. Never invent slugs.
- new_pages[].type MUST be one of: person, concept, project, place, org, source, event, note, profile, todo.
- new_pages[].proposed_slug is kebab-case of the proposed title; do NOT try to disambiguate against the index — backend handles uniqueness.
- No duplicates within an array.
- A slug appearing in touched_pages must NOT also appear as a proposed_slug in new_pages.
- Empty arrays = nothing noteworthy = pipeline short-circuits.

# Decision rules

## Identifying TOUCHED pages

Flag a page when the transcript plausibly adds, refines, contradicts, or expands what the page already says. Standard is plausibility, not certainty.

Triggers:
- Direct mention — entity, project, person, or concept named on the page is referenced by name or alias.
- Pronoun reference — "she said she'd send it" where prior turns make clear "she" = an indexed person.
- Implicit reference — "my startup" matches an existing project page; "my partner" matches an existing person profile.
- Topic match — substantive claim about an area covered by an existing concept, note, or profile sub-page.
- Status-bucket match — for todo pages, transcript contains a commitment that aligns with an existing pending todo.

## Identifying NEW pages

Propose a new page when the transcript introduces an entity / project / concept / commitment that:
- Has no plausible match in the existing index, AND
- Is named with enough specificity to merit a page (real proper noun, clearly-articulated concept, concrete commitment), AND
- Has at least one substantive associated claim (not a bare passing mention).

## Commitment patterns → ALWAYS flag todos/todo

If the transcript contains ANY of these commitment patterns from the user, you MUST flag "todos/todo" as a touched page (assuming it appears in the index):
- "I'll <verb>"
- "I told <person> I'd <verb>"
- "I need to <verb>"
- "Remind me to <verb>"
- "Let me <verb>"
- "I should <verb>"
- "I'm going to <verb>"
- "I want to <verb>"
- "I have to <verb>"

This is unconditional — not a judgment call. Pro depends on todos/todo being in the candidate set to extract implicit todos.

## Recall bias — when in doubt, INCLUDE

You are the recall bottleneck. Pro can cheaply skip candidates you over-flag. Pro CANNOT recover anything you miss — there's no fallback retrieval, no retry.

- False positive (you flag, Pro skips) → modest extra preload tokens, no quality cost.
- False negative (you miss, Pro never sees it) → permanent silent data loss.

When unsure: include. Bias deliberately toward over-flagging both arrays.

## Speaker handling

Use both [user] and [agent] turns for context — the agent's questions establish antecedents that resolve the user's pronouns. But base candidate decisions on the USER's speech. If only the agent mentioned a topic and the user didn't engage, it's not a candidate.

# Examples

## Example 1: pure noteworthy update on an existing person

Transcript:
[user] Sarah called and she got the offer at Anthropic.
[agent] That's huge. When does she start?
[user] Three weeks.

Index includes:
{"slug": "sarah-chen", "title": "Sarah Chen", "type": "person", "parent_slug": null, "agent_abstract": "Friend, working at OpenAI as a research engineer."}

Output:
{"touched_pages": [{"slug": "sarah-chen"}], "new_pages": []}

## Example 2: commitment with implicit todo

Transcript:
[user] I told Alex I'd send him the Karpathy paper this week.
[agent] Got it.

Index includes:
{"slug": "alex-rivera", "title": "Alex Rivera", "type": "person", "parent_slug": null, "agent_abstract": "..."}
{"slug": "todos/todo", "title": "To do", "type": "todo", "parent_slug": "todos", "agent_abstract": "Todos that are pending."}

Output:
{"touched_pages": [{"slug": "alex-rivera"}, {"slug": "todos/todo"}], "new_pages": []}

## Example 3: new entity introduction

Transcript:
[user] I started a side project called Consensus, basically a multi-agent debate framework.
[agent] Interesting. What problem does it solve?
[user] Helping people work through controversial decisions where they're stuck.

Index has no project named "Consensus".

Output:
{"touched_pages": [], "new_pages": [{"proposed_slug": "consensus", "proposed_title": "Consensus", "type": "project"}]}

## Example 4: pure scaffolding — gate negative

Transcript:
[user] Hey what's up.
[agent] Good morning. How are you?
[user] Good thanks. Talk later.

Output:
{"touched_pages": [], "new_pages": []}`;

export async function retrieveCandidates(
  transcript: IngestionTranscriptTurn[],
  wikiIndex: WikiIndexEntry[],
): Promise<FlashCandidateResult> {
  const flat = transcript.map((t) => `[${t.role}] ${t.text}`).join('\n');
  const indexJson = JSON.stringify(wikiIndex, null, 2);

  const userMessage = `# Wiki index\n\n${indexJson}\n\n# Transcript\n\n${flat}`;

  const resp = await getGeminiClient().models.generateContent({
    model: FLASH_MODEL,
    contents: [
      { role: 'user', parts: [{ text: userMessage }] },
    ],
    config: {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          touched_pages: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { slug: { type: Type.STRING } },
              required: ['slug'],
            },
          },
          new_pages: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                proposed_slug: { type: Type.STRING },
                proposed_title: { type: Type.STRING },
                type: { type: Type.STRING },
              },
              required: ['proposed_slug', 'proposed_title', 'type'],
            },
          },
        },
        required: ['touched_pages', 'new_pages'],
      },
      temperature: 0.2,
    },
  });

  const text = resp.text;
  if (!text) {
    logger.warn('flash candidate retrieval returned empty text');
    return { touched_pages: [], new_pages: [] };
  }

  // Lenient JSON extraction — Flash sometimes wraps JSON in prose despite schema.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    logger.warn({ text: text.slice(0, 200) }, 'flash candidate retrieval returned non-JSON');
    return { touched_pages: [], new_pages: [] };
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<FlashCandidateResult>;
  return {
    touched_pages: Array.isArray(parsed.touched_pages) ? parsed.touched_pages : [],
    new_pages: Array.isArray(parsed.new_pages) ? parsed.new_pages : [],
  };
}
