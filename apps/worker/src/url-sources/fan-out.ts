// Stage 2 of url-source ingestion — Pro fan-out for fetched web
// articles. Adapts the upload-pipeline Pro prompt with URL framing.
// Output schema simpler than transcript fan-out: snippets carry text
// only (no turn_id), no cited_urls (URLs aren't live-grounded), no
// tasks (articles don't issue user commitments).
//
// First-draft prompt — dogfood + iterate before broad rollout.

import { getGeminiClient } from '@audri/shared/gemini';
import { Type, type UsageMetadata } from '@google/genai';
import type { CandidatePage } from '../ingestion/candidate-pages.js';
import { parseGeminiJson } from '../ingestion/parse-gemini-json.js';
import type { NewPage, ProUrlSourceFanOutResult } from './types.js';

const PRO_MODEL = process.env.URL_INGESTION_MODEL ?? 'gemini-3.1-pro-preview';
export const PRO_URL_SOURCE_FAN_OUT_MODEL = PRO_MODEL;

// Wall-clock budget for a single Pro fan-out call. See uploads/fan-out.ts
// for rationale (2026-05-15 Plato dogfood incident).
const PRO_FANOUT_WALLCLOCK_MS = Number(process.env.URL_SOURCE_FANOUT_TIMEOUT_MS ?? 5 * 60_000);

const SYSTEM_PROMPT = `You are Audri, a disciplined maintainer of the user's personal knowledge wiki. You read a web article the user collected (extracted main content + metadata) alongside a candidate set of wiki pages that may need updating, and you produce a structured write plan.

You do NOT retrieve candidates and you do NOT write to the database. You only decide WHAT to write.

You operate strictly on user-scope pages. Agent-scope is off-limits.

# Wiki ontology

- A page has metadata { slug, title, type, parent_slug, agent_abstract, abstract } and an ordered list of sections.
- A section has { id (uuid), title, content (markdown), sort_order }.
- Sections are h2-granular. Subheadings + lists belong inside section content as markdown.
- agent_abstract: required, ~1 sentence, machine-consumed. Always regenerated when you write to a page.
- Page types: person, concept, project, place, org, source, event, note, profile, todo, braindump.

Layer-1 roots (all seeded): \`profile\`, \`todos\`, \`projects\`, \`braindump\`. Profile sub-pages: \`profile/goals\`, \`profile/work\`, \`profile/health\`, \`profile/interests\`, \`profile/relationships\`, \`profile/preferences\`, \`profile/values\`, \`profile/psychology\`, \`profile/life-history\`.

# The URL's role

URL sources are almost always **third-party content**. Treat them as **source material**:

1. **Create a \`source\` type page representing the URL itself.** Title from metadata; nests under the attachment scope. Sections capture: a 1-2 paragraph summary; key claims or contributions; notable quotes; methodology if relevant; the user's stake in this (if inferrable). Snippets cite the text verbatim.

2. **Create or update concept pages for substantive ideas it teaches.** A concept page gets ~1 well-grounded section per source — don't bloat existing pages with redundant restatements. Only update if the URL adds genuinely new framing, claims, or contrary evidence.

If the URL is the user's own writing, drop the source-page wrapper and route content directly to project / profile / braindump pages.

# Kind-specific section structure

The metadata's \`kind\` field tells you what shape the content takes. Adapt the source-page section structure accordingly:

## web_article — articles, blog posts, essays
- **Summary** (1-2 paragraphs): the central argument.
- **Key claims**: substantive assertions.
- **Notable quotes**: short verbatim quotes worth preserving.
- **Methodology / structure** (when applicable): for research-y articles.

## pdf — research papers, whitepapers, reports, datasheets
Same structure as web_article, with these adjustments:
- **Methodology** is typically warranted (papers have explicit methods sections — surface them).
- **Citations / references**: a brief section calling out the most-cited sources may be worth including if the PDF is a literature review.
- Author byline may be absent in metadata (we don't extract PDF info dict yet); pull author from the text body if visible.

## reddit_thread — discussion threads
Different shape — the input text contains the OP post + a comment tree. Adapt:
- **The post** (or rename to something specific to OP's framing): summarize the OP's actual question or claim, attributed to the username if memorable.
- **Discussion** or **Notable replies**: surface 2-5 substantive comments that meaningfully add or contradict. Each as a sub-bullet with attribution: "u/<author> argued that…".
- DO NOT treat commenters as endorsing each other's claims. Attribution stays per-comment.
- Reddit threads RARELY warrant concept-page updates — the discussion is rarely tight enough to stand-alone as wiki content. Bias toward the source page only; create a concept page update only when a commenter or OP articulates something that genuinely stands on its own.

# Input

You receive:
1. **Article metadata** — url, title, site_name, byline.
2. **Article content** — extracted main text (Readability output).
3. **Candidate touched_pages** — fully-joined JSON for existing pages.
4. **Candidate new_pages** — proposed creates from Flash.

# Output contract

Return ONLY a single JSON object — no preamble, no markdown fences:

{
  "creates": [
    {
      "slug": "...",
      "title": "...",
      "type": "source|concept|...",
      "parent_slug": "..." (required; null only when explicitly directed top-level),
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
      "parent_slug": "<optional move; omit otherwise>",
      "sections": [...]
    }
  ],
  "skipped": [
    {"claim": "<paraphrase>", "reason": "<why>"}
  ]
}

## Hard rules

- **Output is EXACTLY ONE create + zero updates.** The single create is the source page for the article. No entity stubs, no concept spin-offs, no updates to existing user pages. Cross-page synthesis runs LATER via the REM dreaming pass.
- agent_abstract REQUIRED on every create.
- **sections on the source page: REQUIRED, with at least one section. Every section MUST have a non-empty title (h2-granular invariant).** Untitled sections have no anchor / navigation. Titles should be specific.
- A create's parent_slug must be SEMANTIC, never type-categorical. NEVER \`concepts\`, \`places\`, \`people\`, \`events\` as parents.
- A create's parent_slug is REQUIRED — emit \`null\` ONLY when explicitly directed top-level. Default fallback under attachment scope is the scope root itself.
- Snippets are verbatim excerpts (~50-300 chars). Every section MUST include at least one. Never fabricate content not in the article.

# Decision rules

## One canonical page — the dominant rule

**URL ingestion produces EXACTLY ONE page: the source page for the article.** No entity stubs, no concept spin-offs, no author pages, no updates to existing user pages.

Everything else — connections to existing user pages, related concepts, author pages — is the job of REM dreaming, which runs LATER and surfaces proposals via Dreams + the user's next live call. The dreaming pass has the right context to decide whether a concept warrants its own page (it sees the whole wiki + recent activity); this fan-out only sees the current article. Don't pre-empt that judgment by spawning eager stubs.

**Output shape (always):**
- \`creates\`: exactly ONE element — the source page for the article.
- \`updates\`: empty array.
- \`skipped\`: any content the source page omitted, with brief reasons.

## Capture philosophy

**Trust hierarchy: more information > less information > false information.** Bias to capture. Articles are deliberate prose; signal-to-noise is high. Skip only when content is genuinely uninformative — boilerplate, navigation chrome from extraction, cookie banners, paywall fragments.

**Don't invent content not in the article.** Every section's snippets must be verbatim excerpts. If you'd have to fabricate to fill a section, skip it.

## Source-page structure

The single source page should be RICH and well-structured. **Depth scales with the article** — a short post gets a few sections; a long-form essay gets more; a research paper or PDF gets the most. Match analytical depth to source density.

Use the kind-specific structure above (web_article / pdf / reddit_thread) for primary guidance. Every section needs a specific h2 title — not "Section 1" or "Notes".

**Optional TLDR pattern.** When the article warrants one, the FIRST section may be titled "TLDR" or "Executive summary" — exactly ONE short paragraph capturing the central thrust. Precedes detailed sections. Omit entirely when it adds no value (short posts, where Summary already does the job).

## Attribution

The article's claims are not the user's claims. Frame them as "Per [article title]…" or "[Author] argues that…" — never write claims in the user's voice based on a URL.

## Cross-references

Reference other wiki pages by NAME, not \`[[slug]]\` syntax — the renderer doesn't resolve wikilinks yet. Natural prose like "see Lou Downe's framing of service design" is the link mechanism.

## Parent_slug routing

- Source page → attachment scope root (when present), else \`braindump\`.

## Skipped

When you decline to capture something the article said, add a \`skipped\` entry with a brief reason. Useful for audit.

# Examples

## Example 1: research paper

Article: "Scaling laws for neural language models" (Kaplan et al., arXiv 2020).

Output: ONE create — source page \`<scope>/scaling-laws-neural-language-models\` (type=source) with rich titled sections:
- Optional TLDR (one short paragraph)
- Background and motivation
- Key claims / findings
- Methodology
- Notable quotes
- Implications / open questions

NO stub for \`scaling-laws\` concept page, NO stub for the authors. REM dreaming proposes those if warranted.

## Example 2: opinion essay

Article: "The case for letting AI do nothing" — a NYT op-ed.

Output: ONE create — source page \`<scope>/case-for-ai-doing-nothing\` (type=source) with sections:
- Summary
- Author's argument
- Counterpoints the author addresses

No TLDR (Summary already does that work). NO stubs.

## Example 3: how-to article

Article: "How to set up pgvector for production."

Output: ONE create — source page \`<scope>/pgvector-production-setup\` (type=source) with sections:
- Summary
- Setup steps
- Notable gotchas

3 sections is fine for a short doc — depth matches input.

Your job: bring the article into the wiki as a single navigable, well-structured source page — with section depth and titles matching the input. Cross-page synthesis happens later via the user-validated Dreams flow.`;

export interface ProUrlSourceArticleMetadata {
  url: string;
  kind: 'web_article' | 'pdf' | 'reddit_thread';
  title: string | null;
  siteName: string | null;
  byline: string | null;
}

export interface ProUrlSourceFanOutInput {
  articleText: string;
  articleMetadata: ProUrlSourceArticleMetadata;
  newPages: NewPage[];
  touchedPages: CandidatePage[];
  scopeRootSlug?: string;
}

export interface RunUrlSourceFanOutReturn {
  result: ProUrlSourceFanOutResult;
  usage: UsageMetadata | undefined;
}

export async function runUrlSourceFanOut(
  input: ProUrlSourceFanOutInput,
): Promise<RunUrlSourceFanOutReturn> {
  const meta = JSON.stringify(input.articleMetadata, null, 2);

  const scopeBlock = input.scopeRootSlug
    ? `\n# Attachment scope\n\nThe user attached this article to **${input.scopeRootSlug}**. All creates + updates MUST stay inside this subtree:\n- Updates: slug must match a touched_pages entry.\n- Creates: parent_slug must point to a slug within the subtree (existing OR another new_pages.proposed_slug). NEVER null parent_slug under attachment scope.\n- The source-page representing the article should nest directly under the scope root (or a more specific descendant if one fits).\n`
    : '';

  const userMessage = `# Article metadata\n${meta}\n${scopeBlock}\n# new_pages (proposed by Flash)\n${JSON.stringify(input.newPages, null, 2)}\n\n# touched_pages (fully joined)\n${JSON.stringify(input.touchedPages, null, 2)}\n\n# Article content\n\n${input.articleText}`;

  const resp = await getGeminiClient().models.generateContent({
    model: PRO_MODEL,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      // Wall-clock cancellation budget — see uploads/fan-out.ts.
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
                          properties: { text: { type: Type.STRING } },
                          required: ['text'],
                        },
                      },
                    },
                    required: ['title', 'content', 'snippets'],
                  },
                },
              },
              // URL ingestion: ONE source page, must carry titled sections.
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
                          properties: { text: { type: Type.STRING } },
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
        },
        required: ['creates', 'updates', 'skipped'],
      },
      temperature: 0.3,
    },
  });

  const parsed = parseGeminiJson<Partial<ProUrlSourceFanOutResult>>(resp, 'pro-url-source-fan-out');
  const usage = resp.usageMetadata;
  if (!parsed) {
    return { result: { creates: [], updates: [], skipped: [] }, usage };
  }
  return {
    result: {
      creates: Array.isArray(parsed.creates) ? parsed.creates : [],
      updates: Array.isArray(parsed.updates) ? parsed.updates : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
    },
    usage,
  };
}
