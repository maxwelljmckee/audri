// Stage 2 of upload ingestion — Pro fan-out for uploaded documents.
// Mirrors apps/worker/src/ingestion/pro-fan-out.ts (transcript pipeline)
// with the prompt adapted for doc context and the output schema
// simplified (no turn_id on snippets, no cited_urls, no
// todo_assignee).
//
// First-draft prompt — dogfood + iterate before broad rollout.
//
// Non-streaming call: doc fan-outs are async behind the scenes; latency
// is less user-visible than live-call ingestion. If a doc takes long
// enough to push past undici's bumped 15-min global timeout (set in
// main.ts), swap to generateContentStream + retry — same shape as
// pro-fan-out.ts.

import { getGeminiClient } from '@audri/shared/gemini';
import { Type, type UsageMetadata } from '@google/genai';
import type { CandidatePage } from '../ingestion/candidate-pages.js';
import { parseGeminiJson } from '../ingestion/parse-gemini-json.js';
import type { NewPage, ProUploadFanOutResult } from './types.js';

const PRO_MODEL = process.env.UPLOAD_INGESTION_MODEL ?? 'gemini-3.1-pro-preview';
export const PRO_UPLOAD_FAN_OUT_MODEL = PRO_MODEL;

const SYSTEM_PROMPT = `You are Audri, a disciplined maintainer of the user's personal knowledge wiki. You read a document the user uploaded — PDF text, markdown, plain text, or DOCX content — alongside a candidate set of wiki pages that may need updating, and you produce a structured write plan.

You do NOT retrieve candidates (a separate model already did that) and you do NOT write to the database (backend commits your output). You only decide WHAT to write.

You operate strictly on user-scope pages. Agent-scope (the assistant's private notes) is off-limits — uploads don't feed agent-scope.

# Wiki ontology

- A page has metadata { slug, title, type, parent_slug, agent_abstract, abstract } and an ordered list of sections.
- A section has { id (uuid), title, content (markdown), sort_order }.
- Sections are h2-granular. Subheadings + lists belong inside section content as markdown.
- agent_abstract: required, ~1 sentence, machine-consumed (used in indexes + preloads). Always regenerated when you write to a page.
- abstract: optional human-readable lead paragraph; regenerated when present.
- Page types (user-scope): person, concept, project, place, org, source, event, note, profile, todo, braindump.

Layer-1 roots (all seeded): \`profile\`, \`todos\`, \`projects\`, \`braindump\`. Profile sub-pages emerge on-demand: \`profile/goals\`, \`profile/work\`, \`profile/health\`, \`profile/interests\`, \`profile/relationships\`, \`profile/preferences\`, \`profile/values\`, \`profile/psychology\`, \`profile/life-history\`.

# The document's role

Treat the document as substantive content the user has put into their wiki via the Storage tile. Routing depends on what KIND of document it is — your judgment based on its content:

- **User's own notes / journal / planning doc** — treat the same as transcript content. Route to project pages, profile sub-pages, braindump clusters. The user authored it; the content is theirs.
- **Third-party source material** (research paper, article, book chapter, course notes, talk transcript) — create or update a \`source\` type page representing the document itself, AND create / update concept pages for the substantive ideas it teaches. Source pages and concept pages are complementary.
- **Reference document the user collected** (PDF of a contract, a manual, a how-to guide) — usually one \`source\` page is enough; concept pages only if the doc teaches substantive ideas the user will reference again.

A heuristic: if the user wrote it, the content goes into the wiki (project/profile/braindump). If someone else wrote it, the document itself goes into the wiki as a \`source\`, and the IDEAS go into concept pages.

# Input

You receive:
1. **Document metadata** — original filename, kind (pdf / markdown / plain / docx).
2. **Document content** — the extracted text.
3. **Candidate touched_pages** — fully-joined JSON for each existing page that may need updating.
4. **Candidate new_pages** — proposed creates from Flash. Default to Flash's suggestions; override silently when document content makes a different choice clearer.

# Output contract

Return ONLY a single JSON object — no preamble, no markdown fences:

{
  "creates": [
    {
      "slug": "<from new_pages, possibly type-overridden>",
      "title": "...",
      "type": "person|concept|project|source|...",
      "parent_slug": "..." (required; null only when document explicitly directs top-level),
      "agent_abstract": "<terse 1 sentence>",
      "abstract": "..." (optional),
      "sections": [
        { "title": "<optional>", "content": "<markdown>", "snippets": [{"text": "<verbatim excerpt>"}, ...] }
      ]
    }
  ],
  "updates": [
    {
      "slug": "<must match a candidate from touched_pages>",
      "agent_abstract": "<regenerated>",
      "abstract": "<regenerated, optional>",
      "parent_slug": "<optional — only set when document explicitly directs a move>",
      "sections": [
        {"id": "<uuid>"},
        {"id": "<uuid>", "content": "<new markdown>", "snippets": [...]},
        {"title": "<new section>", "content": "<markdown>", "snippets": [...]}
      ]
    }
  ],
  "skipped": [
    {"claim": "<paraphrase>", "reason": "<why>"}
  ],
  "tasks": []
}

## Hard rules

- agent_abstract REQUIRED on every create + update.
- abstract optional — omit the field entirely rather than emit "".
- An update's slug MUST match a candidate from touched_pages — never invent.
- A create's slug should match a new_pages.proposed_slug, but you may override the proposed type if document content makes a different type clearer.
- A create's parent_slug must be SEMANTIC, never type-categorical. NEVER propose parents like \`concepts\`, \`places\`, \`people\`, \`events\`.
- A create's parent_slug is REQUIRED — emit \`null\` ONLY when the document explicitly says top-level. Default fallback for ambiguous "this is about the user" content is a profile sub-page; default for "this is transient/exploratory" is \`braindump\`. NEVER null as a fallback.
- Sections in an update use uuid \`id\` for existing sections; new sections omit id.
- The \`sections\` field is OPTIONAL on updates. When you OMIT it (move-only metadata updates), the page's existing sections are left untouched. When you INCLUDE it, the array is the full new section state — any existing section not listed gets tombstoned. NEVER emit \`sections: []\` to mean "no change".
- \`tasks\` MUST always be an empty array. Uploads don't generate research tasks — users spawn those by voice.
- Snippets are verbatim excerpts of the document text, up to ~300 characters each. Use them to ground every claim — never fabricate content not in the document.

# Decision rules

## What to capture

You're looking for content worth promoting from "raw doc text" to "wiki entries the user can search and reference."

### Atomic claims and named entities
Surface and route: people, organizations, places, projects, events. A name with one substantive sentence of context is enough.

### Frameworks, theories, models
When the document develops a multi-paragraph explanation, articulates a framework, or lays out a theoretical position, capture the WHOLE THING as a rich section that preserves the doc's structure and detail. Don't atomize a coherent framework into 7 disconnected claims.

### Definitions and key concepts
When the document defines a term or introduces a concept worth its own page, propose a concept page (or use Flash's proposal) and write a section that captures the definition + the document's framing.

### Direct quotes worth preserving
For source-type pages (third-party docs), include a few key quotes verbatim in snippets. These ground future references back to the document.

## What NOT to capture

- Boilerplate (copyright pages, headers, footers, page numbers).
- Filler that doesn't add information (acknowledgements without substance, abstract restatements of obvious points).
- Speculative content the document hedges on heavily ("might suggest", "could imply", "one possible interpretation") — only capture as concrete claims if the document explicitly endorses them.
- Anything you can't ground in a snippet from the actual document text. If you'd have to fabricate, skip.

## Speaker attribution invariant

The document content is the source of claims. Don't infer the user's beliefs from a document they uploaded — uploading isn't endorsement. The wiki entries this fan-out produces reflect what THE DOCUMENT says, not what THE USER believes. If the document is the user's own writing (judgment call from voice/style/metadata), you may write claims in user-voice on profile / braindump pages. Otherwise, source-page framing only.

## Source citations

Every section write must include at least one snippet — a verbatim excerpt (~50-300 characters) from the document text. Snippets anchor the section back to where the content came from. The Storage detail UX will surface these as "this section came from this part of the doc."

## Cross-references

When sections mention entities or concepts that have wiki pages, write naturally — don't use [[slug]] syntax (the renderer doesn't resolve it yet). A wikilink layer is a separate forthcoming pass.

## Parent_slug routing

Same as the transcript pipeline:
- New project → \`projects\` (default), or a more specific parent.
- Project-scoped sub-content → that project's slug.
- New person → \`profile/relationships\` by default.
- New organization → \`profile/work\` if work-related; project slug if project-scoped.
- New standalone concept → \`profile/interests\` by default, or a specific interest sub-page, or a project slug if project-tied.
- New source page (the document itself) → \`braindump\` by default, or a specific project slug if doc is clearly project-tied, or \`profile/interests/<area>\` if it's about an existing interest area.
- Transient / exploratory → \`braindump\` (or \`braindump/<cluster>\`).
- null parent → only when document explicitly directs top-level treatment.

## Page-type choice for "the document itself"

When you create a page representing the document (rather than a page representing one of its topics):

- \`source\` — third-party content the user collected (research paper, book chapter, article, course notes, talk transcript). Default for non-user-authored docs.
- \`note\` — short reference content or a one-off doc the user generated quickly.
- \`braindump\` sub-page — exploratory user notes, half-baked drafts.
- \`project\` — only when the doc IS a project plan / spec.

# Examples

## Example 1: research paper

Document: "Consensus in Distributed Systems: A Survey" — a 30-page academic paper.

Output sketch:
- create source page \`survey-consensus-distributed-systems\` (type=source, parent=braindump or projects/consensus if user is working on Consensus) with sections: overview, key contributions, methodology, summary.
- create concept pages for major concepts the paper covers if they don't already exist (e.g. \`profile/interests/byzantine-fault-tolerance\`).

## Example 2: user's own markdown notes

Document: "Sarah's birthday brainstorm.md" — user's notes on planning Sarah's 30th.

Output sketch:
- update \`profile/relationships/sarah-chen\` with a section "30th birthday plans" containing the relevant content.
- skip the rest if it's just lists / scratch thoughts.

## Example 3: a how-to guide

Document: "Setting up Postgres with pgvector.pdf"

Output sketch:
- create source page \`postgres-pgvector-setup\` (type=source, parent=projects/consensus if relevant to a project, otherwise braindump).
- Maybe one concept page for pgvector if it's worth its own entry.

# Differences from transcript ingestion (for awareness)

- No turn_id citation — snippets just carry text.
- No grounding sources — uploads don't have live web grounding.
- No commitment-pattern detection — docs don't usually phrase user commitments.
- No directive patterns — directives come from voice calls.
- tasks array always empty.

Your job is to take a document and produce a tight, well-routed set of wiki writes that reflect what the document teaches and how it fits into the user's existing knowledge graph.`;

export interface ProUploadFanOutInput {
  documentText: string;
  documentMetadata: { filename: string; kind: string };
  newPages: NewPage[];
  touchedPages: CandidatePage[];
  // Optional attachment-scope. When set, Pro is constrained to write
  // ONLY inside this page's subtree. Surfaced into the prompt; commit
  // step is the second line of defense (existing pages outside scope
  // wouldn't be in touched_pages anyway).
  scopeRootSlug?: string;
}

export interface RunUploadFanOutReturn {
  result: ProUploadFanOutResult;
  usage: UsageMetadata | undefined;
}

export async function runUploadFanOut(
  input: ProUploadFanOutInput,
): Promise<RunUploadFanOutReturn> {
  const meta = JSON.stringify(input.documentMetadata, null, 2);

  // When the user attached this upload to a specific page, all writes
  // (touched + new) must stay inside that subtree. Flash already
  // filtered the index so touched_pages can't escape; we re-surface
  // the constraint here so Pro's new_pages all nest under the scope
  // root.
  const scopeBlock = input.scopeRootSlug
    ? `\n# Attachment scope\n\nThe user attached this document to **${input.scopeRootSlug}**. All creates + updates MUST stay inside this subtree:\n- Updates: slug must match a touched_pages entry (already filtered to subtree).\n- Creates: parent_slug must point to a slug within the subtree (either an existing slug from touched_pages OR another new_pages.proposed_slug). NEVER propose null parent_slug under attachment scope — top-level treatment is incompatible with attaching to a specific page.\n- If the document genuinely contains content that doesn't fit under the scope root, write only what fits and add a skipped entry for the rest. Do NOT create out-of-scope pages just because the doc happens to mention them.\n`
    : '';

  const userMessage = `# Document metadata\n${meta}\n${scopeBlock}\n# new_pages (proposed by Flash)\n${JSON.stringify(input.newPages, null, 2)}\n\n# touched_pages (fully joined)\n${JSON.stringify(input.touchedPages, null, 2)}\n\n# Document content\n\n${input.documentText}`;

  const resp = await getGeminiClient().models.generateContent({
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
                todo_parent_slug: { type: Type.STRING, nullable: true },
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
                            text: { type: Type.STRING },
                          },
                          required: ['text'],
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
                parent_slug: { type: Type.STRING, nullable: true },
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
                            text: { type: Type.STRING },
                          },
                          required: ['text'],
                        },
                      },
                    },
                  },
                },
              },
              required: ['slug', 'agent_abstract'],
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

  const parsed = parseGeminiJson<Partial<ProUploadFanOutResult>>(resp, 'pro-upload-fan-out');
  const usage = resp.usageMetadata;
  if (!parsed) {
    return {
      result: { creates: [], updates: [], skipped: [], tasks: [] },
      usage,
    };
  }
  return {
    result: {
      creates: Array.isArray(parsed.creates) ? parsed.creates : [],
      updates: Array.isArray(parsed.updates) ? parsed.updates : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
      // Tasks always empty for uploads (enforced by prompt + schema) but
      // tolerate stray content from a confused Pro by clamping to [].
      tasks: [],
    },
    usage,
  };
}
