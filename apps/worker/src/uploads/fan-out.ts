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

// Wall-clock budget for a single Pro fan-out call. SDK's `abortSignal`
// support fires the cancellation client-side after this elapses (Google
// still charges for tokens already produced — we just stop waiting). 5
// minutes is generous for legitimate output but tight enough to catch
// genuine runaways (the 2026-05-15 Plato hang ran >17min before manual
// abort, with no native cap). Override via env if a future long-input
// case legitimately needs more.
const PRO_FANOUT_WALLCLOCK_MS = Number(process.env.UPLOAD_FANOUT_TIMEOUT_MS ?? 5 * 60_000);

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

Treat the document as substantive content the user has put into their wiki via the Storage tile. Your output is exactly ONE page that represents the document. Page type depends on what KIND of document it is — your judgment based on its content:

- **Third-party source material** (research paper, article, book chapter, course notes, talk transcript) → \`source\` page.
- **Reference document the user collected** (PDF of a contract, a manual, a how-to guide) → \`source\` page (or \`note\` if very short).
- **User's own notes / journal / planning doc** → \`note\` page (or \`braindump\` sub-page for exploratory drafts).

In all three cases the output shape is the same: one page, with sections (each titled), depth matching the doc. No entity stubs, no concept spin-offs, no updates to existing user pages. Cross-page synthesis is REM dreaming's job, not this fan-out's.

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

- **Output is EXACTLY ONE create + zero updates.** The single create is the source page representing the document. No entity stubs, no concept spin-offs, no author pages, no updates to existing user pages. Cross-page synthesis runs LATER via the REM dreaming pass. See "One canonical page" rule below for the full rationale.
- agent_abstract REQUIRED on every create.
- abstract optional — omit the field entirely rather than emit "".
- **sections on the source page: REQUIRED, with at least one section. Every section MUST have a non-empty title (h2-granular invariant).** Untitled sections have no anchor / no navigation and are a structural failure. Be specific in titles — "Books I-II: Justice as advantage" not "Section 1".
- A create's slug should match a new_pages.proposed_slug, but you may override the proposed type if document content makes a different type clearer.
- A create's parent_slug must be SEMANTIC, never type-categorical. NEVER propose parents like \`concepts\`, \`places\`, \`people\`, \`events\`.
- A create's parent_slug is REQUIRED — emit \`null\` ONLY when the document explicitly says top-level. Default fallback for ambiguous "this is about the user" content is a profile sub-page; default for "this is transient/exploratory" is \`braindump\`. NEVER null as a fallback. Under attachment scope, parent_slug must point inside the scope subtree.
- \`tasks\` MUST always be an empty array. Uploads don't generate research tasks — users spawn those by voice.
- Snippets are verbatim excerpts of the document text, up to ~300 characters each. Use them to ground every claim — never fabricate content not in the document.

# Decision rules

## Capture philosophy

**Trust hierarchy: more information > less information > false information.** Bias to capture. Documents are higher-signal than spoken transcripts (less filler, more deliberate prose), so the practical noise risk is small. Skip only when content is genuinely uninformative — boilerplate, page numbers, copyright pages, navigation chrome from extraction.

**Don't invent content not in the document.** Every section's snippets must be verbatim excerpts from the document text. If you'd have to fabricate to fill a section, skip the section. This is the only hard "skip" rule — everything else is judgement.

**Examples worth capturing in full:**
- A multi-paragraph framework, theory, or coherent argument — keep as ONE rich section that preserves the doc's structure. Don't atomize a coherent body of reasoning into 7 disconnected claims.
- A definition or key concept the document introduces deliberately.
- Direct quotes worth preserving verbatim (especially on source pages — these ground future references back to the doc).
- Substantive treatment of a named entity (person, org, concept) — capture the doc's framing of them.

**Examples worth skipping:**
- Boilerplate, copyright, headers, footers, page numbers, navigation chrome.
- Acknowledgements without substance.
- Heavy hedging the document doesn't endorse ("might suggest", "could imply") — capture only what the doc actually commits to.

## One canonical page — the dominant rule

**Doc ingestion produces EXACTLY ONE page: the source page for the document itself.** No entity stubs. No concept spin-offs. No author pages. No cross-references into existing user pages.

Everything else — connections to existing concepts, related-author pages, conceptual cross-links, integration with the broader knowledge base — is the job of REM dreaming, which runs LATER as a separate proposal pass surfaced to the user via Dreams + their next live call.

This is intentionally restrictive. The earlier "spawn stubs when warranted" / "leaf-node vs bucket" / "content promotion path" guidance led Pro to over-spawn under-content pages (the 2026-05-15 Plato's Republic incident produced 4 sibling stub pages with empty bodies). The clean rule is simpler: **one doc → one page.**

If the document mentions an entity that warrants standalone treatment, that's a real signal — but it's a signal for the Dreams pass to surface as a proposal ("you uploaded a paper that introduces a concept worth its own page — want to talk about it?"), NOT for this fan-out to spawn a stub eagerly.

**Output shape (always):**
- \`creates\`: exactly ONE element — the source page for the document.
- \`updates\`: empty array. Doc ingestion never updates existing pages.
- \`skipped\`: any content the source page omitted, with brief reasons.

## Source-page structure

The single source page should be RICH and well-structured. Depth scales with the document — a short article gets a few sections; a dense paper gets many; a full book gets potentially dozens. Match the depth of analysis to the depth + density of the source material. A 400-page book deserves treatment substantially deeper than the same-template "TLDR / key claims / notable quotes" you'd give a blog post.

**Section titles are REQUIRED.** Every section MUST have a non-empty title — sections are h2-granular and an untitled section is a structural failure (no anchor, no navigation, no scannability). Titles should be specific and informative ("Books I-II: Justice as advantage" or "Tripartite soul: reason, spirit, appetite" — not "Section 1" or "Notes").

**Optional TLDR pattern.** When the doc warrants one, the FIRST section may be titled "TLDR" or "Executive summary" — one short paragraph that captures the document's central thrust at a glance. This is exactly ONE section (not a recurring pattern). It precedes the detailed sections below. Omit entirely for docs where it adds no value — short articles, how-to guides, anything where the detailed sections are themselves brief enough to scan.

**Worked structure — Plato's Republic (~400 pages):**

✅ CORRECT shape (illustrative; adapt section titles + count to actual content):
- TLDR — 1 short section, executive summary of the dialogue
- Setting and dramatic frame — Cephalus's house, who's present, the conversational pretext
- Book I: Conventional definitions of justice — Cephalus, Polemarchus, Thrasymachus
- Books II–IV: Constructing the ideal city — division of labor, the three classes, the tripartite soul analogy
- Book V: Community of wives, children, philosopher-kings
- Books VI–VII: The Forms, the divided line, the cave allegory
- Books VIII–IX: Degeneration of regimes — timocracy → oligarchy → democracy → tyranny
- Book X: Critique of imitative poetry, the Myth of Er
- Reception and influence — brief, only if the doc covers it

That's 8-9 substantive sections for a book of this size, each with a specific h2 title, each with multi-paragraph content. Compare to the 2026-05-15 first attempt which produced 6 untitled sections averaging ~220 chars each for the same book — that's 1300 chars total to represent 400 pages. Don't be that thin.

❌ WRONG shapes:
- 6 sections with no titles (the 2026-05-15 incident).
- 200 sections matching every chapter / sub-chapter (over-fragmentation).
- TLDR + 1 other section called "Detailed overview" containing one giant wall of text.

## Skipped — for content the source page omits

When you deliberately leave material out of the source page (because the doc has digressions, repetition, or content too narrow to warrant inclusion), add a \`skipped\` entry with a brief reason. Useful audit trail.

## Attribution (NOT speaker attribution — document attribution)

The document content is the source of claims. Don't infer the user's beliefs from a document they uploaded — uploading isn't endorsement. Wiki entries this fan-out produces reflect what THE DOCUMENT says, not what THE USER believes. If the document is the user's own writing (judgment call from voice/style/metadata/filename), you may write claims in user-voice on profile / braindump pages. Otherwise, frame as "Per [doc title]…" or "[Author] argues that…" on source / concept pages.

This is the doc-ingestion analog of the transcript pipeline's "agent turns only count when user accepts" rule. Different mechanism, same goal: avoid putting words in the user's mouth.

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

## Example 1: medium-length research paper (~30 pages)

Document: "Consensus in Distributed Systems: A Survey" — 30-page academic paper.

Output:
- ONE create — source page \`survey-consensus-distributed-systems\` (type=source) under the attachment-scope parent. Sections (each with required h2 title):
  - Optional TLDR (1 short paragraph)
  - Background and motivation
  - Key contributions
  - Methodology
  - Notable findings
  - Limitations / open questions

About 5-7 substantive sections, each multi-paragraph. NO concept-page spin-offs (e.g., \`byzantine-fault-tolerance\`) — REM dreaming will propose those if the paper warrants them.

## Example 2: full-length book (~400 pages)

Document: "Plato's Republic" — full book.

Output:
- ONE create — source page \`plato-the-republic\` (type=source) under the attachment-scope parent. Sections (each with required h2 title):
  - Optional TLDR (1 short paragraph)
  - Setting and dramatic frame
  - Book I: Conventional definitions of justice
  - Books II–IV: Constructing the ideal city
  - Book V: Community of wives, children, philosopher-kings
  - Books VI–VII: Forms, divided line, cave allegory
  - Books VIII–IX: Degeneration of regimes
  - Book X: Critique of poetry, Myth of Er
  - Author and reception (brief, only if covered in the doc)

8-9 substantive sections matching the book's actual structure. NO sibling pages for Plato, Socrates, "Justice (Platonic Concept)", etc. — those characters / concepts appear inline within the relevant sections. REM dreaming proposes any spin-offs the user might want.

## Example 3: short how-to guide

Document: "Setting up Postgres with pgvector.pdf" — 8-page guide.

Output:
- ONE create — source page \`postgres-pgvector-setup\` (type=source). Sections:
  - Summary
  - Setup steps
  - Notable gotchas

3 sections is fine for a short doc — depth matches input. NO TLDR (the Summary section is short enough on its own; adding TLDR would duplicate). NO concept page for pgvector — REM may propose one later if the user accumulates more pgvector material.

# Differences from transcript ingestion (for awareness)

- No turn_id citation — snippets just carry text.
- No grounding sources — uploads don't have live web grounding.
- No commitment-pattern detection — docs don't usually phrase user commitments.
- No directive patterns — directives come from voice calls.
- \`tasks\` array always empty.
- **Output is EXACTLY ONE PAGE.** No entity stubs, no updates to existing user pages, no concept spin-offs. The transcript pipeline DOES write multi-target updates + spawn named-entity pages; the doc pipeline does NEITHER. All cross-page synthesis runs through REM dreaming later, surfaced to the user via Dreams + their next call.

Your job: bring a document into the wiki as a single navigable, well-structured source page — with section depth and title quality matching the input. Cross-page enrichment happens later via the user-validated Dreams flow.`;

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

export async function runUploadFanOut(input: ProUploadFanOutInput): Promise<RunUploadFanOutReturn> {
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
      // Wall-clock cancellation budget. SDK aborts the request client-side
      // when the signal fires; Google still bills any tokens produced
      // before then. Caller's catch surfaces a clear error.
      abortSignal: AbortSignal.timeout(PRO_FANOUT_WALLCLOCK_MS),
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
                      // REQUIRED — sections are h2-granular; untitled
                      // sections have no anchor / navigation.
                      title: { type: Type.STRING },
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
                    required: ['title', 'content', 'snippets'],
                  },
                },
              },
              // Doc ingestion: ONE source page, required to carry sections.
              // The "one canonical page" rule means stub pages are no longer
              // a permitted shape; every create must be a content-bearing
              // source page.
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
