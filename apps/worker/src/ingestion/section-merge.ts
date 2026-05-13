// Section content merger — used when the commit step encounters a
// pre-existing section that collides with a new section being written.
//
// Trigger conditions in `commit.ts`:
//   - Pro fan-out emitted a `PageCreate` whose slug already exists in
//     wiki_pages (slug collision) → falls back to merge mode against
//     the existing page.
//   - Within that merge, any new section whose title matches an existing
//     non-tombstoned section on the same page routes through here to
//     produce a merged content body (not overwrite, not append-blindly).
//
// Implementation: cheap Flash call. Typical merge cost ~$0.001 per
// section (~1k input + 0.5k output tokens at gemini-2.5-flash rates).
// Best-effort: on failure, the caller falls back to appending the new
// content under a divider (preserves data without an extra LLM hop).

import { getGeminiClient } from '@audri/shared/gemini';
import type { UsageMetadata } from '@google/genai';
import { logger } from '../logger.js';
import { recordInferenceUsage } from '../usage/record-inference.js';

export const SECTION_MERGE_MODEL = 'gemini-2.5-flash';

export interface MergeSectionInput {
  pageTitle: string;
  sectionTitle: string | null;
  existingContent: string;
  incomingContent: string;
}

export interface MergeSectionOutput {
  content: string;
  usage: UsageMetadata | undefined;
  fallbackApplied: boolean;
}

const MERGE_PROMPT_PREAMBLE = `You are merging two versions of a wiki section that share the same title on the same page. Your job is to produce a single coherent merged section that preserves every distinct piece of information from both versions.

RULES:
- Preserve ALL distinct facts, claims, examples, and details from both versions.
- Deduplicate where they overlap — don't repeat the same fact twice in different wording.
- Maintain coherent prose flow; the merged section should read as one piece, not two stapled together.
- Keep the same general voice + style as the existing content (it's already in the user's wiki).
- Do not introduce new facts that aren't in either source.
- Do not editorialize, add headers, or change the section title.
- Return ONLY the merged section body content. No preamble, no explanation, no markdown title.`;

function buildMergePrompt(input: MergeSectionInput): string {
  const titleLine = input.sectionTitle
    ? `Section title: "${input.sectionTitle}"`
    : "Section is the page's leading section (no explicit title).";
  return `${MERGE_PROMPT_PREAMBLE}

Page: "${input.pageTitle}"
${titleLine}

EXISTING content (currently in the wiki):
"""
${input.existingContent}
"""

INCOMING content (new from this ingestion):
"""
${input.incomingContent}
"""

Merged section body:`;
}

// Fallback when the merge call fails: append the incoming content under
// a dated divider. Preserves both versions verbatim without losing
// information; the user can clean up by hand later if it reads awkwardly.
function fallbackAppend(input: MergeSectionInput): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${input.existingContent}\n\n---\n\n_Added ${today}:_\n\n${input.incomingContent}`;
}

export async function mergeSectionContent(
  input: MergeSectionInput,
  meta: { userId: string; agentId?: string; transcriptId?: string },
): Promise<MergeSectionOutput> {
  const prompt = buildMergePrompt(input);
  try {
    const resp = await getGeminiClient().models.generateContent({
      model: SECTION_MERGE_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        // No structured response — plain text body.
        temperature: 0.3,
      },
    });

    const text = resp.text?.trim();
    if (!text) {
      logger.warn(
        {
          pageTitle: input.pageTitle,
          sectionTitle: input.sectionTitle,
          existingLen: input.existingContent.length,
          incomingLen: input.incomingContent.length,
        },
        'section-merge: empty response — falling back to append',
      );
      return {
        content: fallbackAppend(input),
        usage: resp.usageMetadata,
        fallbackApplied: true,
      };
    }

    // Record usage even though it's a small Flash call — keeps cost
    // attribution honest. Best-effort; helper swallows insert failures.
    void recordInferenceUsage({
      userId: meta.userId,
      agentId: meta.agentId,
      callTranscriptId: meta.transcriptId ?? null,
      eventKind: 'ingestion',
      model: SECTION_MERGE_MODEL,
      usage: resp.usageMetadata,
    });

    return {
      content: text,
      usage: resp.usageMetadata,
      fallbackApplied: false,
    };
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        pageTitle: input.pageTitle,
        sectionTitle: input.sectionTitle,
      },
      'section-merge: call failed — falling back to append',
    );
    return {
      content: fallbackAppend(input),
      usage: undefined,
      fallbackApplied: true,
    };
  }
}
