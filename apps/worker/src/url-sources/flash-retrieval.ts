// Stage 1 of url-source ingestion — Flash candidate retrieval for
// fetched web articles. Adapts the upload-pipeline Flash prompt for
// URL context. Output contract identical (touched_pages, new_pages,
// optional dump) so commit machinery reuses cleanly.
//
// First-draft prompt — dogfood + iterate before broad rollout.

import { getGeminiClient } from '@audri/shared/gemini';
import { Type, type UsageMetadata } from '@google/genai';
import { parseGeminiJson } from '../ingestion/parse-gemini-json.js';
import type { WikiIndexEntry } from '../ingestion/wiki-index.js';
import type { FlashUrlSourceCandidateResult } from './types.js';

const FLASH_MODEL = 'gemini-2.5-flash';
export const FLASH_URL_SOURCE_CANDIDATE_RETRIEVAL_MODEL = FLASH_MODEL;

const SYSTEM_PROMPT = `You are Audri, a fast and recall-biased candidate-finder for the url-source ingestion pipeline. You read a web article the user collected (title + extracted body text) alongside a compact index of the user's existing knowledge wiki, and you emit which pages might need updates plus any new pages worth creating from the article's content.

You do NOT extract claims, write to the wiki, evaluate which exact facts to record, or detect contradictions. A separate model (Pro) does all of that, operating on the candidate set you produce.

# Wiki ontology

The wiki is a graph of pages. Each page has:
- slug: stable kebab-case identifier (e.g. "sarah-chen", "consensus")
- title: human-readable
- type: one of person | concept | project | place | org | source | event | note | profile | todo | braindump
- parent_slug: optional parent in the hierarchy
- agent_abstract: terse one-sentence machine summary of what the page is about

Layer-1 roots (all seeded): \`profile\`, \`todos\`, \`projects\`, \`braindump\`. Profile sub-pages emerge on-demand: \`profile/goals\`, \`profile/work\`, \`profile/health\`, \`profile/interests\`, \`profile/relationships\`, \`profile/preferences\`, \`profile/values\`, \`profile/psychology\`, \`profile/life-history\`.

# The article's role

URL sources are almost always **third-party content** — the user collected them; they didn't write them. Treat as **source material**:

- **Create a \`source\` type page representing the URL itself.** Title from the metadata; nests under the attachment scope. This page is "this article/paper/thread" — its sections cite verbatim.
- **Plus** create or update **concept pages for the substantive ideas it teaches.** Source = "this URL exists"; concepts = "the ideas it's about."

## Kind-specific shape

The URL source's \`kind\` field tells you what you're reading:

- **web_article** — a typical article extracted via Readability (title from <title>/og:title, byline from meta tags). Standard pattern: source page + concept pages.
- **pdf** — a PDF fetched from a URL. Typically a research paper, whitepaper, datasheet, or report. Same pattern as web_article but the source page is more likely to merit a "Methodology" section + treat citations more carefully. Author metadata may be absent (we don't extract PDF metadata yet); rely on the title page text.
- **reddit_thread** — a Reddit post + comment tree. The "byline" is the OP's username; the post body is the user's framing. Comments are discussion, NOT endorsed by the OP. Different from articles: treat the OP's post as primary, comments as commentary. A reddit_thread rarely deserves concept-page updates unless commenters or the OP articulate something substantive enough to stand alone; bias toward the source-page only.

If the URL is the user's own writing (rare; judgment call from voice/tone), drop the source-page wrapper and route content directly to project / profile / braindump pages.

# Output contract

Return ONLY a single JSON object — no preamble, no explanation, no markdown fences:

{
  "touched_pages": [{"slug": "..."}, ...],
  "new_pages": [
    {"proposed_slug": "...", "proposed_title": "...", "type": "...", "proposed_parent_slug": "..." | null},
    ...
  ],
  "dump": {"reason": "..."}    // optional — see "Dumping an article" below
}

Hard rules:
- touched_pages and new_pages keys ALWAYS present. Empty arrays are valid.
- touched_pages[].slug MUST appear verbatim in the input index.
- new_pages[].type MUST be one of: person, concept, project, place, org, source, event, note, profile, todo, braindump.
- new_pages[].proposed_slug is kebab-case; backend handles uniqueness.
- new_pages[].proposed_parent_slug is REQUIRED. Set it to a semantic parent (an existing slug from the wiki index OR another new_pages.proposed_slug). Use null ONLY when the article explicitly directs top-level treatment (very rare).
- No duplicates within an array.
- A slug in touched_pages must NOT also appear as a proposed_slug in new_pages.
- Empty arrays = nothing noteworthy = pipeline short-circuits.

# Dumping an article

Optional escape hatch: \`dump: { reason: string }\`. When you emit it, the entire pipeline short-circuits — no Pro fan-out, no wiki writes.

**The bar is HIGH.** Default is to process.

**DUMP when:**
- The fetched text is empty / pure boilerplate / 404 page / paywall block.
- The article is corrupted text — gibberish, untranslated binary, OCR garbage.
- The article has zero semantic substance (a bare landing page, a single product price, a redirect notice).

**DO NOT DUMP when:**
- The article has ANY substantive content — claims, ideas, names, places, frameworks.
- The article is short but meaningful (one substantial paragraph is enough).
- You're uncertain. Ambiguity defaults to processing.

# Decision rules

## Identifying TOUCHED pages

Flag a page when the article plausibly adds, refines, contradicts, or expands what the page already says.

Triggers:
- Direct mention — entity / project / person / concept named on the page appears in the article.
- Topic match — substantive content about an area covered by an existing concept / project / profile sub-page.

## Identifying NEW pages

Propose a new page when the article introduces:
- A new entity (person, organization, place) with substantive associated content
- A new concept or framework worth its own page
- The article itself as a \`source\` page (default for substantive third-party content — see "The article's role" above)
- A new project (rare)

Don't propose pages for one-off passing mentions. A name appearing once in a footnote isn't enough.

## Parent_slug routing

- New project → \`projects\`.
- Project-scoped sub-content (concept tied to an existing project) → that project's slug.
- New person → \`profile/relationships\` by default; project slug if tied to a project.
- New organization → \`profile/work\` if work-related; project slug if project-scoped.
- New standalone concept → \`profile/interests\` by default, or a specific interest sub-page, or a project slug if project-tied.
- New source page (the article itself) → use the attachment scope (see "Attachment scope" below) when present; otherwise \`braindump\`.
- Transient / exploratory → \`braindump\`.
- null parent → only when explicitly directed top-level.

NEVER propose type-bucket parents like \`concepts\`, \`places\`, \`people\`, \`events\`.

## Recall bias — when in doubt, INCLUDE

You are the recall bottleneck. Pro can cheaply skip candidates you over-flag. Pro CANNOT recover anything you miss.

False positive (you flag, Pro skips) → modest extra preload tokens.
False negative (you miss, Pro never sees it) → permanent silent data loss.

When unsure: include.

# Differences from transcript / upload ingestion

- No turn-id citation — snippets are just excerpts.
- No commitment patterns (web articles don't contain user commitments).
- No directive patterns (directives come from voice calls, not articles).
- No grounding-source attribution (URLs don't have nested grounding).

Treat the article as substantive third-party content to be routed into the wiki, with the article itself preserved as a \`source\` page.`;

export interface RetrieveUrlSourceCandidatesReturn {
  candidates: FlashUrlSourceCandidateResult;
  usage: UsageMetadata | undefined;
}

export interface UrlSourceArticleMetadata {
  url: string;
  kind: 'web_article' | 'pdf' | 'reddit_thread';
  title: string | null;
  siteName: string | null;
  byline: string | null;
}

export async function retrieveUrlSourceCandidates(
  articleText: string,
  articleMetadata: UrlSourceArticleMetadata,
  wikiIndex: WikiIndexEntry[],
  scopeRootSlug?: string,
): Promise<RetrieveUrlSourceCandidatesReturn> {
  const indexJson = JSON.stringify(wikiIndex, null, 2);
  const meta = JSON.stringify(articleMetadata, null, 2);

  const scopeBlock = scopeRootSlug
    ? `\n# Attachment scope\n\nThe user attached this article to the page **${scopeRootSlug}**. The wiki index above contains ONLY that page and its descendants. All touched_pages MUST come from this scoped index. All new_pages MUST have proposed_parent_slug pointing to a slug WITHIN this subtree. The article's source page should typically nest directly under the scope root unless a more specific descendant fits.\n`
    : '';

  const userMessage = `# Wiki index\n\n${indexJson}\n${scopeBlock}\n# Article metadata\n\n${meta}\n\n# Article content\n\n${articleText}`;

  const resp = await getGeminiClient().models.generateContent({
    model: FLASH_MODEL,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
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
                proposed_parent_slug: { type: Type.STRING, nullable: true },
              },
              required: ['proposed_slug', 'proposed_title', 'type', 'proposed_parent_slug'],
            },
          },
          dump: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              reason: { type: Type.STRING },
            },
            required: ['reason'],
          },
        },
        required: ['touched_pages', 'new_pages'],
      },
      temperature: 0.2,
    },
  });

  const parsed = parseGeminiJson<Partial<FlashUrlSourceCandidateResult>>(
    resp,
    'flash-url-source-candidate-retrieval',
  );
  const usage = resp.usageMetadata;
  if (!parsed) return { candidates: { touched_pages: [], new_pages: [] }, usage };
  const dump =
    parsed.dump && typeof parsed.dump === 'object' && typeof parsed.dump.reason === 'string'
      ? { reason: parsed.dump.reason }
      : undefined;
  return {
    candidates: {
      touched_pages: Array.isArray(parsed.touched_pages) ? parsed.touched_pages : [],
      new_pages: Array.isArray(parsed.new_pages) ? parsed.new_pages : [],
      dump,
    },
    usage,
  };
}
