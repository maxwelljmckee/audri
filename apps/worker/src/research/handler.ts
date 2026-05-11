// Research plugin handler — vault-first delta research. Per specs/research-task-prompt.md.
//
// v0.2 refactor: research is no longer a freestanding artifact-only pipeline.
// Each run starts with a vault scan of the user's existing notes on the
// topic; the prompt receives those sections as `## Existing knowledge` and
// is biased to research the GAP between what the user has + the world.
// Output includes both the human-readable research artifact AND a
// structured delta (creates + section-appends) that gets applied to the
// user's notes in the same commit transaction. See `vault-scan.ts` and
// `commit.ts`.
//
// Note: Gemini's grounded-search mode and `responseSchema` are mutually
// exclusive (the SDK / model rejects schema constraints when googleSearch is
// enabled). So we instruct the model to emit JSON in the prompt and parse +
// validate post-hoc with zod.

import { getGeminiClient } from '@audri/shared/gemini';
import type { Tool, UsageMetadata } from '@google/genai';
import { z } from 'zod';
import { logger } from '../logger.js';
import { type VaultScanResult, renderVaultScan, vaultScan } from './vault-scan.js';

// gemini-3.1-pro-preview supports grounded search. Override via env for dev.
const RESEARCH_MODEL = process.env.RESEARCH_MODEL ?? 'gemini-3.1-pro-preview';

export const ResearchPayloadZ = z.object({
  query: z.string().min(1),
  context_summary: z.string().optional(),
  source_transcript_id: z.string().uuid().optional(),
  source_turn_id: z.string().optional(),
  user_profile_brief: z
    .object({
      name: z.string().optional(),
      interests_summary: z.string().optional(),
    })
    .optional(),
  preferred_depth: z.enum(['overview', 'detailed']).optional(),
});
export type ResearchPayload = z.infer<typeof ResearchPayloadZ>;

const FindingZ = z.object({
  heading: z.string().min(1),
  content: z.string().min(1),
  citation_indices: z.array(z.number().int().nonnegative()),
});

// Delta — additive-only wiki updates derived from the research. Two shapes:
//
//  - `creates`: brand-new wiki pages with their initial sections. Must
//    specify a parent_slug so the page nests under the user's existing
//    structure (almost always under `profile/<area>` or `projects/<slug>`).
//  - `section_appends`: NEW sections under existing wiki pages, addressed
//    by the page_id surfaced in the vault scan. We DON'T overwrite or
//    contradict existing sections in v0.2 — that requires the claim-model
//    substrate to handle gracefully (V1+ work).
//
// The point: research output isn't just a freestanding artifact anymore;
// it accretes onto the user's notes. Each delta entry references the
// research_outputs row as its provenance once committed.
const DeltaCreatePageZ = z.object({
  slug: z.string().min(1),
  type: z.enum(['person', 'concept', 'project', 'place', 'org', 'source', 'event', 'note']),
  parent_slug: z.string().min(1),
  title: z.string().min(1),
  agent_abstract: z.string().min(1),
  sections: z
    .array(
      z.object({
        title: z.string().min(1),
        content: z.string().min(1),
      }),
    )
    .min(1),
});

const DeltaSectionAppendZ = z.object({
  page_id: z.string().uuid(),
  title: z.string().min(1),
  content: z.string().min(1),
  // Optional explanation for the user, surfaced in the wiki UI as
  // provenance for why the new section landed.
  reason: z.string().optional(),
});

export const ResearchDeltaZ = z.object({
  creates: z.array(DeltaCreatePageZ).default([]),
  section_appends: z.array(DeltaSectionAppendZ).default([]),
  // Free-form rationale the model surfaces about WHAT it chose to add and
  // why. Surfaces in the UI so the user can audit the delta at a glance.
  notes: z.string().optional(),
});
export type ResearchDelta = z.infer<typeof ResearchDeltaZ>;

export const ResearchOutputZ = z.object({
  query: z.string(),
  // Short user-facing label (~6-10 words). Distinct from query — query holds
  // the verbatim ask; title is a tight summary used as the primary heading
  // in lists and detail views.
  title: z.string().min(1),
  summary: z.string().min(1),
  findings: z.array(FindingZ).min(1),
  citations: z
    .array(
      z.object({
        url: z.string().url().or(z.string().min(1)),
        title: z.string(),
        snippet: z.string(),
      }),
    )
    .default([]),
  follow_up_questions: z.array(z.string()).optional(),
  notes_for_user: z.string().optional(),
  // Vault-first delta — additive wiki updates derived from the research.
  // Empty delta is valid (e.g. when the user already has the topic well-
  // covered and no new info is worth adding).
  delta: ResearchDeltaZ.default({ creates: [], section_appends: [] }),
});
export type ResearchOutput = z.infer<typeof ResearchOutputZ>;

export interface ResearchHandlerResult {
  output: ResearchOutput;
  scan: VaultScanResult;
  modelUsed: string;
  // Full Gemini usage metadata — consumed by research/commit.ts to write
  // a `usage_events` row with cost computed via the shared pricing module.
  // Undefined when the model omitted the field (rare but possible).
  usage: UsageMetadata | undefined;
}

const SYSTEM_PROMPT = `You are Audri's research handler. You are NOT in conversation with the user — you produce a written research report AND a structured delta that updates the user's personal notes.

# Goal
Given a research query AND a snapshot of the user's existing notes on the topic (\`## Existing knowledge\`), produce TWO things:
1. A thorough, well-cited written report that fills the gaps in what the user already has.
2. A structured delta — additive wiki updates that compound the research onto the user's existing notes.

# Vault-first principle
The user's existing notes are the FIRST source. Research the WORLD only for what's missing or stale.
- If the user has 5 sections on the topic, don't re-derive what those sections cover. Read them, identify what's missing, search for THAT.
- If the user has nothing on the topic, research from scratch.
- Your external queries should be GAP-TARGETED, not generic. "What does the user already know about X?" → "What does the world know about X that the user doesn't?"

# Tool use
You have access to Google Search via grounding. Use it AGGRESSIVELY for any factual claim that goes beyond the user's existing knowledge — better to over-ground than to assert without sources. Every substantive finding should be backed by at least one citation drawn from search results.

# Voice
- Direct and factual. No hype. No "great question!" or "I'd love to help."
- Acknowledge uncertainty where present.
- Don't roleplay any persona — this is a research artifact, not a conversation.

# Length + depth
Default ('overview'):
- Summary: 2-4 sentences
- Findings: 3-6 headings, each ~150-300 words
- Total: ~1500-2500 words

If the payload's preferred_depth is 'detailed':
- Summary: 4-6 sentences
- Findings: 5-10 headings, each ~250-500 words
- Total: ~3500-5000 words

# Citation discipline
- Every finding's content makes at least one cited claim
- citation_indices reference the global \`citations\` array (1-indexed; 0 reserved for "no citation")
- Don't fabricate citations — if grounded search returned nothing useful, the \`notes_for_user\` field says so explicitly
- Domain diversity preferred where possible
- **Each citation's \`url\` MUST be the full article URL from grounded search results** (e.g. \`https://nytimes.com/2026/04/28/dining/italian-restaurants-manhattan.html\`), NOT the publisher's homepage (e.g. \`https://nytimes.com\`). The user clicks these links to read the actual cited source — bare domain roots are useless. If a particular finding came from a publisher's homepage with no specific article URL, omit that citation entirely rather than emit a useless root link.

# Refusal / out-of-scope
- If the query isn't actually researchable (e.g. "research my own goals"), produce zero findings and a notes_for_user explaining why
- If the query is harmful, refuse via notes_for_user
- If the query implies access to private data you don't have (email, calendar), explain the gap

# The delta — wiki updates
The delta is the second product of this run. It accretes the research onto the user's notes. Two shapes:

## delta.creates
Brand-new wiki pages with initial sections. Use when the topic is genuinely new — the user has no existing page that fits. Each create needs:
- \`slug\`: kebab-case, scoped under a parent (e.g. \`profile/interests/stoicism\`)
- \`type\`: one of person / concept / project / place / org / source / event / note. Pick semantically.
- \`parent_slug\`: REQUIRED. Existing page slug from the vault scan. Almost always nests under \`profile/<area>\` (e.g. \`profile/interests\`) or \`projects/<slug>\`. Top-level (parent_slug = same as slug-prefix) is rare.
- \`title\`: human-readable
- \`agent_abstract\`: terse 1-2 sentence machine-consumed summary of what this page is about
- \`sections\`: at least one section with \`title\` + \`content\` (markdown prose)

## delta.section_appends
NEW sections under EXISTING wiki pages, addressed by the \`page_id\` surfaced in the vault scan. Use when the user has a relevant page but is missing the angle this research surfaces. Each append needs:
- \`page_id\`: from the vault scan output
- \`title\`: section heading (must be unique within the page)
- \`content\`: markdown prose
- \`reason\` (optional): one sentence explaining why this section is being added

## What NOT to put in the delta
- DO NOT update or overwrite existing sections (no contradictions, no edits). v0.2 is additive-only; contradictions are handled by V1+ work.
- DO NOT include the verbatim research summary or citations — those are stored separately as the research artifact.
- DO NOT add sections that just restate what an existing section already says.
- An EMPTY delta is correct when the user's existing knowledge is already comprehensive. \`{ "creates": [], "section_appends": [] }\` is fine.

## Voice for delta content
- 2nd person ("you") when addressing the user. NEVER 3rd person ("the user", "they") — that voice belongs in agent-scope notes, not user-facing wiki content.
- Distill, don't dump. Wiki content is the user's PERSONAL knowledge file — terse, useful, indexed for future reference. NOT the same as the research artifact's prose.
- Each delta section should be self-contained: short paragraphs the user can scan, NOT essay form.

# Output format
Output ONLY a single JSON object with EXACTLY these top-level keys — no preamble, no markdown fences:

{
  "query": "<echo the input query verbatim>",
  "title": "<6-10 word abbreviated title for this research; capitalized like a headline; no trailing punctuation. e.g. 'The Enlightenment and its influence' or 'Italian restaurants in lower Manhattan'>",
  "summary": "<2-4 sentence executive summary>",
  "findings": [
    {
      "heading": "<short heading>",
      "content": "<markdown prose; multi-paragraph allowed>",
      "citation_indices": [1, 3]
    }
  ],
  "citations": [
    { "url": "...", "title": "...", "snippet": "..." }
  ],
  "follow_up_questions": ["<2-4 questions the research surfaced>"],
  "notes_for_user": "<optional caveats / gaps / 'couldn't find' notes>",
  "delta": {
    "creates": [
      {
        "slug": "profile/interests/stoicism",
        "type": "concept",
        "parent_slug": "profile/interests",
        "title": "Stoicism",
        "agent_abstract": "Greco-Roman philosophy emphasizing virtue, reason, and emotional self-mastery; the user is exploring it as a framework for personal practice.",
        "sections": [
          { "title": "Core ideas", "content": "<terse personal-notes prose>" }
        ]
      }
    ],
    "section_appends": [
      {
        "page_id": "<uuid from the vault scan>",
        "title": "Marcus Aurelius vs. Seneca",
        "content": "<terse personal-notes prose>",
        "reason": "Existing page covers Stoicism generally but doesn't compare key figures."
      }
    ],
    "notes": "<optional: model's rationale for what was added vs. skipped>"
  }
}

If you didn't gather any citations from grounding, leave \`citations\` as an empty array and explain in \`notes_for_user\`.
If the existing notes already cover the topic comprehensively, leave \`delta.creates\` and \`delta.section_appends\` as empty arrays and note that in \`delta.notes\`.`;

function composeUserMessage(payload: ResearchPayload, scanRender: string): string {
  const parts: string[] = [`# Research query\n\n${payload.query}`];
  if (payload.context_summary) {
    parts.push(`\n# Context from the originating conversation\n\n${payload.context_summary}`);
  }
  if (payload.user_profile_brief) {
    const brief = payload.user_profile_brief;
    const lines: string[] = [];
    if (brief.name) lines.push(`Name: ${brief.name}`);
    if (brief.interests_summary) lines.push(`Interests: ${brief.interests_summary}`);
    if (lines.length > 0) {
      parts.push(`\n# About the user\n\n${lines.join('\n')}`);
    }
  }
  if (payload.preferred_depth) {
    parts.push(`\n# Depth\n\nUse "${payload.preferred_depth}" length guidelines.`);
  }
  // Vault scan — always included (renders an explicit "no existing notes"
  // message when empty, so the model doesn't have to infer).
  parts.push('', scanRender);
  return parts.join('\n');
}

export async function runResearch(
  userId: string,
  payload: ResearchPayload,
): Promise<ResearchHandlerResult> {
  // Stage 1: vault scan. Identifies the user's existing notes on the topic.
  const scan = await vaultScan(userId, payload.query);
  logger.info(
    { sectionsFound: scan.sections.length, query: payload.query.slice(0, 80) },
    'research handler: vault scan complete',
  );

  // Stage 2: research with the scan as context.
  const userMessage = composeUserMessage(payload, renderVaultScan(scan));

  const tools: Tool[] = [{ googleSearch: {} }];

  const resp = await getGeminiClient().models.generateContent({
    model: RESEARCH_MODEL,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      tools,
      temperature: 0.4,
    },
  });

  const text = resp.text;
  if (!text) throw new Error('research handler: empty response');

  // Tolerate stray prose around the JSON object.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    logger.warn({ textHead: text.slice(0, 300) }, 'research handler: non-JSON response');
    throw new Error('research handler: response did not contain JSON');
  }

  const parsed = JSON.parse(text.slice(start, end + 1));
  // Echo the input query if the model dropped it (defensive).
  if (!parsed.query) parsed.query = payload.query;
  // Fallback title if the model omitted it: truncate the query.
  if (!parsed.title || typeof parsed.title !== 'string') {
    parsed.title =
      payload.query.length > 60 ? `${payload.query.slice(0, 60).trimEnd()}…` : payload.query;
  }

  // Reconcile citations against the SDK's groundingMetadata.groundingChunks.
  // Models often emit publisher-domain URLs in their free-form output even
  // though the grounding chunks they used carry the full article URL. Walk
  // the model's citations array and upgrade each url to the full URL from
  // the matching grounding chunk (matched by hostname). Any model citation
  // whose URL can't be upgraded to a deep URL is dropped — bare domain
  // roots are useless for cross-linking.
  const groundingChunks = extractGroundingChunks(resp);
  if (Array.isArray(parsed.citations)) {
    parsed.citations = reconcileCitations(parsed.citations, groundingChunks);
  } else {
    parsed.citations = [];
  }

  const validated = ResearchOutputZ.parse(parsed);

  return {
    output: validated,
    scan,
    modelUsed: RESEARCH_MODEL,
    usage: resp.usageMetadata,
  };
}

interface GroundingChunkWeb {
  uri?: string;
  title?: string;
}

interface GroundingMeta {
  candidates?: Array<{
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: GroundingChunkWeb }>;
    };
  }>;
}

function extractGroundingChunks(resp: unknown): GroundingChunkWeb[] {
  const meta = resp as GroundingMeta;
  const chunks = meta.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  return chunks
    .map((c) => c.web ?? {})
    .filter((w) => typeof w.uri === 'string' && w.uri.length > 0);
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function isDeepUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // Anything beyond a `/` or empty path counts as deep enough.
    return u.pathname !== '/' && u.pathname.length > 1;
  } catch {
    return false;
  }
}

interface RawCitation {
  url?: unknown;
  title?: unknown;
  snippet?: unknown;
}

function reconcileCitations(
  modelCitations: RawCitation[],
  groundingChunks: GroundingChunkWeb[],
): Array<{ url: string; title: string; snippet: string }> {
  // Index grounding chunks by hostname. Multiple chunks per host are
  // possible — keep all so we can pick a stable one per model citation.
  const chunksByHost = new Map<string, GroundingChunkWeb[]>();
  for (const chunk of groundingChunks) {
    if (!chunk.uri) continue;
    const host = hostname(chunk.uri);
    if (!host) continue;
    const list = chunksByHost.get(host) ?? [];
    list.push(chunk);
    chunksByHost.set(host, list);
  }

  // Track which grounding chunk uris are already claimed so we don't bind
  // multiple model citations to the same article.
  const claimed = new Set<string>();

  const upgraded: Array<{ url: string; title: string; snippet: string }> = [];
  for (const c of modelCitations) {
    const rawUrl = typeof c.url === 'string' ? c.url : '';
    const rawTitle = typeof c.title === 'string' ? c.title : '';
    const rawSnippet = typeof c.snippet === 'string' ? c.snippet : '';

    // If the model already returned a deep URL, keep it.
    if (rawUrl && isDeepUrl(rawUrl)) {
      upgraded.push({ url: rawUrl, title: rawTitle, snippet: rawSnippet });
      continue;
    }

    // Otherwise try to find an unclaimed grounding chunk on the same host.
    const host =
      hostname(rawUrl) ??
      rawUrl
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split('/')[0]
        ?.toLowerCase() ??
      '';
    const candidates = chunksByHost.get(host) ?? [];
    const match = candidates.find((c) => c.uri && !claimed.has(c.uri));
    if (match?.uri) {
      claimed.add(match.uri);
      upgraded.push({
        url: match.uri,
        title: rawTitle || match.title || '',
        snippet: rawSnippet,
      });
      continue;
    }

    // No deep URL available anywhere — drop. Bare-domain citations are
    // useless for cross-linking; skipping them is honest.
    logger.warn({ rawUrl, host }, 'research handler: dropped citation with no deep URL available');
  }

  // Append any grounding chunks the model didn't cite explicitly. They
  // were used for grounding so they belong in the sources panel.
  for (const chunk of groundingChunks) {
    if (!chunk.uri || claimed.has(chunk.uri)) continue;
    upgraded.push({ url: chunk.uri, title: chunk.title ?? '', snippet: '' });
  }

  return upgraded;
}
