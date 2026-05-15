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

- agent_abstract REQUIRED on every create + update.
- sections on creates: OPTIONAL. Sparse cross-link stub pages (just \`{ slug, title, type, agent_abstract }\`) are valid. DO NOT invent placeholder sections like "Overview: Cited in article" to fill quota.
- An update's slug MUST match a candidate from touched_pages.
- A create's parent_slug must be SEMANTIC, never type-categorical. NEVER \`concepts\`, \`places\`, \`people\`, \`events\` as parents.
- A create's parent_slug is REQUIRED — emit \`null\` ONLY when explicitly directed top-level. Default fallback under attachment scope is the scope root itself.
- Sections in an update use uuid \`id\` for existing sections; new sections omit id.
- The \`sections\` field is OPTIONAL on updates. Omit = leave existing sections untouched (move-only metadata update). Include = full new section state; anything missing gets tombstoned. NEVER emit \`sections: []\` to mean "no change".
- Snippets are verbatim excerpts (~50-300 chars). Every section write must include at least one. Never fabricate content not in the article.
- **URL ingestion is CONTAINED.** Output a source page (the article) plus minimal cross-link entity stubs when warranted. DO NOT enrich existing user pages with content drawn from this article. Cross-page integration runs LATER as a separate "REM dream" synthesis pass that proposes enrichments for the user to accept/reject via the Dreams UX. \`updates\` should be RARE on URL ingestion — only for cross-link stubs Flash flagged that already exist, or move-only metadata updates the user explicitly directed.

# Decision rules

## Capture philosophy

**Trust hierarchy: more information > less information > false information.** Bias to capture. Articles are deliberate prose; signal-to-noise is high. Skip only when content is genuinely uninformative — boilerplate, navigation chrome from extraction, cookie banners, paywall fragments.

**Don't invent content not in the article.** Every section's snippets must be verbatim excerpts. If you'd have to fabricate to fill a section, skip it.

## Doc-consolidation pattern (THE KEY DIFFERENCE from transcript ingestion)

**Articles consolidate; transcripts atomize.** This is an intentional asymmetry.

In transcripts, named entities get their own pages — many small pages spawn from one conversation.

In articles, **the source page is the canonical home.** Bias toward a single rich source page with multiple sections per the kind-specific structure above — not a constellation of fragmented sub-pages.

Cross-link to existing OR newly-created entity pages when:
- The article gives an entity SUBSTANTIVE treatment (more than a name + role) AND
- The entity is worth standalone reference (a recurring author, a load-bearing concept, an org the user has other things on).

**Duplication is permitted and encouraged.** The article's "Authors" or "Key claims" section can describe a person in two sentences AND a separate person page can exist with its own treatment. Cross-references in natural prose ("see also: [person's] broader work") are the link mechanism — write prose, not \`[[slug]]\` syntax.

## Dominant output pattern

For a substantive third-party article:
- **1 source-page create** — the article itself, with kind-specific section structure (web_article / pdf / reddit_thread).
- **0-2 stub entity-page creates** — only when an entity is substantively treated AND is worth standalone reference, AND doesn't already exist. Stubs can be sparse \`{ slug, title, type, agent_abstract }\` only — the article page's section carries the actual treatment; the stub exists as a cross-link target.
- **0 updates to existing user pages.** Cross-page integration (e.g. "this article enriches \`profile/interests/scaling-laws\`") is RESERVED for REM dreaming, not for this fan-out. The dreaming pass surfaces those as proposals for the user to discuss in their next call.

Updates ARE permitted only for: (a) move-only metadata changes explicitly directed, or (b) when Flash flagged an existing page that needs metadata regeneration as a side-effect of the new source page being created.

## Leaf-node vs bucket — for spawned entity pages

When deciding whether a mentioned entity warrants its own stub page (vs. just appearing in the article page's sections):

- **Bucket** = will accumulate notes over time → page (a recurring author, a core concept central to user interests).
- **Leaf node** = mentioned once, unlikely to grow → keep in the article page's relevant section, no separate page.

Default: when in doubt, **keep it in the article page**. URL ingestion under-spawns rather than over-spawns; if a leaf turns out to be a bucket, REM dreaming or a future article will promote it.

## Content promotion (across articles / calls)

The wiki has a natural promotion path: \`bullet → section → sub-page\`. For URL ingestion:

- If a concept the article develops ALREADY has substantive coverage across other sources / pages, the current article's contribution may warrant a sparse stub concept page (cross-link target).
- Otherwise: write the concept inside the article page's section. Future sources can promote.

Promote only on strong signal. A first mention isn't enough. Over-spawning fragments the wiki.

## Attribution

The article's claims are not the user's claims. Frame them as "Per [article title]…" or "[Author] argues that…" — never write claims in the user's voice based on a URL. The source page makes this attribution structural; any stub entity pages spawned should also keep attribution clear in their (typically sparse) framing.

## Cross-references

Reference other wiki pages by NAME, not \`[[slug]]\` syntax — the renderer doesn't resolve wikilinks yet (separate forthcoming pass). Natural prose like "see Lou Downe's framing of service design" is the link mechanism.

## Parent_slug routing

- Source page (the article) → attachment scope root (when present), else \`braindump\`.
- Stub concept page → \`profile/interests\` (or specific interest sub-page) by default; project slug if project-tied.
- Stub person page (author / subject) → \`profile/relationships\`.
- Stub organization page → \`profile/work\` if work-related; project slug if project-scoped.

## Skipped

When you decline to capture something the article said, add a \`skipped\` entry with a one-sentence reason. Useful for audit + for future cycles to recheck.

# Examples

## Example 1: research paper

Article: "Scaling laws for neural language models" (Kaplan et al., arXiv 2020).

Output sketch:
- create source page \`<scope>/scaling-laws-neural-language-models\` (type=source) with rich sections: Summary, Key claims, Notable quotes, Methodology, Authors (mentions Kaplan et al. with 2-3 sentences each).
- 0-1 stub creates: e.g. \`scaling-laws\` concept page under \`profile/interests\` IF it doesn't exist AND the user has other content suggesting it's a recurring interest. Stub can be just \`{ slug, title, type, agent_abstract }\`.
- DO NOT update existing \`profile/interests/scaling-laws\` (if it already exists) with a new section. REM dreaming will propose that integration for the user to discuss in their next call.

## Example 2: opinion essay

Article: "The case for letting AI do nothing" — a NYT op-ed.

Output sketch:
- create source page \`<scope>/case-for-ai-doing-nothing\` (type=source) with sections: Summary, Key claims, Author's framing.
- 0 stubs typically — opinion essays rarely warrant standalone concept pages on their own. If the user has a strong AI-safety interest, REM dreaming will surface "this essay relates to your ai-safety page" as a proposal.

## Example 3: how-to article

Article: "How to set up pgvector for production."

Output sketch:
- create source page \`<scope>/pgvector-production-setup\` (type=source) with sections: Summary, Setup steps, Notable gotchas.
- Stub concept page \`pgvector\` ONLY if the user doesn't have one AND the article gives it standalone treatment beyond the install steps. Sparse is fine.

Your job: bring the article into the wiki as a navigable, well-structured source. Leave existing user pages untouched — cross-page enrichment runs later via the user-validated Dreams flow.`;

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
                          properties: { text: { type: Type.STRING } },
                          required: ['text'],
                        },
                      },
                    },
                    required: ['content', 'snippets'],
                  },
                },
              },
              // `sections` is OPTIONAL — sparse cross-link stub pages
              // (just slug + title + type + agent_abstract) are valid.
              required: ['slug', 'title', 'type', 'agent_abstract'],
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
