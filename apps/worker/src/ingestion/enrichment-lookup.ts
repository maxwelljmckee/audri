// agent_notes-directed enrichment lookups.
//
// Fires a single bounded Gemini Flash call with googleSearch grounding +
// JSON-via-prompt to fetch structured fields named by an `agent_notes` rule
// on a target wiki page. Run BEFORE Pro fan-out; the structured result is
// passed into Pro's input under `enrichment_lookups` keyed by new-page slug.
//
// Architectural framing (2026-05-18 design discussion): Pro stays tool-less
// and deterministic — this module runs in the worker pipeline OUTSIDE Pro's
// inference loop, fired by deterministic triggers (Flash structural output
// + rule presence), single-shot, no iteration. Not an agentic loop; just a
// pre-Pro helper.
//
// Note: Gemini's googleSearch grounding and responseSchema are mutually
// exclusive (same constraint the research handler hit — see handler.ts
// header). We instruct the model to emit JSON in the prompt and parse it
// out post-hoc.

import { getGeminiClient } from '@audri/shared/gemini';
import { recordInferenceUsage } from '@audri/shared/usage';
import type { Tool } from '@google/genai';
import { logger } from '../logger.js';

const FLASH_MODEL = 'gemini-2.5-flash';

// Wall-clock budget for one enrichment lookup. Flash + grounding is fast
// (typically 2–5s), but networks misbehave. 30s is generous; abort beyond.
const LOOKUP_TIMEOUT_MS = Number(process.env.ENRICHMENT_LOOKUP_TIMEOUT_MS ?? 30_000);

export interface EnrichmentLookupResult {
  rule_excerpt: string;
  query: string;
  fields: Record<string, string | null>;
  sources: Array<{ uri: string; title?: string; domain?: string }>;
}

export interface LookupOpts {
  // Free-form description of what's being looked up (entity + disambiguators).
  query: string;
  // Snake_case field names to extract. May include open-ended judgment items
  // (e.g. ["author", "year_published", "premise", "historical_context"]).
  // Pass [] for fully-open rules; the model will use judgment.
  fields: string[];
  // The agent_notes excerpt that triggered this lookup — included in the
  // returned struct so Pro can see why this lookup was fired.
  ruleExcerpt: string;
  // For usage_events attribution.
  userId: string;
  agentId: string;
  callTranscriptId: string;
}

function buildSystemPrompt(): string {
  return `You are a structured fact extractor. The caller will ask you to look up information about a specific entity and return SPECIFIC named fields, populated from grounded web sources.

You have googleSearch grounding available. Use it: run a focused search query for the entity, then extract the named fields from the grounded results.

# Output contract

Return ONLY a single JSON object — no preamble, no markdown fences:

{
  "fields": {
    "<field_name>": "<value or null>",
    ...
  }
}

# Field semantics

- Keys MUST match the field names the caller requested, exactly (snake_case, as provided).
- Values are short, fact-stripped strings — a name, a year, a one-line premise, etc. NOT paragraphs unless the field name itself implies length (e.g. "synopsis" can be a sentence or two).
- If you can't find a field with confidence, emit \`null\` — do NOT fabricate.
- If the caller's \`fields\` list is empty (open-ended), use judgment: include a handful of obvious fields for the entity type (e.g. for a book: title, author, year_published, premise). Stay terse — half a dozen fields at most.
- If the caller's \`fields\` list includes open-ended hints ("any other relevant info", "or anything pertinent"), include the named anchors PLUS a few judgment-call extras (one or two), never a research dump.

# Constraints

- Do NOT invent fields beyond what was requested (closed rules) or what's clearly relevant (open rules).
- Do NOT emit a "summary" or "explanation" field unless requested.
- Values must be GROUNDED — derived from search results, not from your training knowledge alone. If grounding contradicts your prior, trust grounding.
- Empty / null is better than guessed.

# Example

Request: query="The book Sapiens by Yuval Noah Harari", fields=["author", "year_published", "premise"]
Output:
{"fields": {"author": "Yuval Noah Harari", "year_published": "2011", "premise": "A sweeping history of humankind from the cognitive revolution to the present day."}}
`;
}

function buildUserMessage(opts: LookupOpts): string {
  const fieldsBlock =
    opts.fields.length === 0
      ? '(open-ended — use judgment)'
      : opts.fields.map((f) => `- ${f}`).join('\n');
  return `# query\n${opts.query}\n\n# fields_to_extract\n${fieldsBlock}\n\n# rule_excerpt (the agent_notes rule that triggered this lookup, FYI only)\n${opts.ruleExcerpt}`;
}

interface ParsedLookup {
  fields: Record<string, string | null>;
}

function parseLookupResponse(text: string): ParsedLookup | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!obj || typeof obj !== 'object') return null;
    const fieldsRaw = (obj as { fields?: unknown }).fields;
    if (!fieldsRaw || typeof fieldsRaw !== 'object' || Array.isArray(fieldsRaw)) return null;
    const fields: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(fieldsRaw as Record<string, unknown>)) {
      if (v === null || typeof v === 'string') {
        fields[k] = v;
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        fields[k] = String(v);
      } else {
        // skip non-scalar
      }
    }
    return { fields };
  } catch {
    return null;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: matches @google/genai response shape
function extractSources(resp: any): Array<{ uri: string; title?: string; domain?: string }> {
  const chunks = resp?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  // biome-ignore lint/suspicious/noExplicitAny: SDK chunk shape varies; defensive
  return chunks.flatMap((c: any) => {
    const uri = c?.web?.uri;
    if (!uri) return [];
    return [
      {
        uri,
        title: c?.web?.title,
        domain: c?.web?.domain,
      },
    ];
  });
}

export async function lookupEnrichment(opts: LookupOpts): Promise<EnrichmentLookupResult | null> {
  const tools: Tool[] = [{ googleSearch: {} }];
  const startedAt = Date.now();
  try {
    const resp = await getGeminiClient().models.generateContent({
      model: FLASH_MODEL,
      contents: [{ role: 'user', parts: [{ text: buildUserMessage(opts) }] }],
      config: {
        systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
        abortSignal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        tools,
      },
    });
    const text = resp.text ?? '';
    const parsed = parseLookupResponse(text);
    const sources = extractSources(resp);

    // Best-effort usage recording. Flash inference + grounding both bill;
    // costed via the same model rate (Flash) for simplicity.
    void recordInferenceUsage({
      userId: opts.userId,
      agentId: opts.agentId,
      callTranscriptId: opts.callTranscriptId,
      eventKind: 'tool_lookup',
      model: FLASH_MODEL,
      usage: resp.usageMetadata,
    }).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'enrichment-lookup: usage record failed (non-fatal)',
      );
    });

    if (!parsed) {
      logger.warn(
        {
          query: opts.query,
          fieldsCount: opts.fields.length,
          textLength: text.length,
          totalMs: Date.now() - startedAt,
        },
        'enrichment-lookup: JSON parse failed; skipping enrichment',
      );
      return null;
    }

    logger.info(
      {
        query: opts.query,
        fieldsRequested: opts.fields.length,
        fieldsReturned: Object.keys(parsed.fields).length,
        sourceCount: sources.length,
        totalMs: Date.now() - startedAt,
      },
      'enrichment-lookup: complete',
    );

    return {
      rule_excerpt: opts.ruleExcerpt,
      query: opts.query,
      fields: parsed.fields,
      sources,
    };
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        query: opts.query,
        totalMs: Date.now() - startedAt,
      },
      'enrichment-lookup: failed; ingestion continues without enrichment',
    );
    return null;
  }
}

// Detect whether a page's agent_notes carries an enrichment-directing rule.
// Coarse: looks for "lookup" / "look up" / "fetch" / "search" / "include"
// patterns combined with field-naming language. False positives just mean
// we fire a lookup that may not be needed; false negatives mean we skip
// enrichment that was requested. Bias toward firing (cheap).
const ENRICHMENT_TRIGGER_PATTERN =
  /\b(look[- ]?up|fetch|search|find|retriev(?:e|ing)|pull)\b[^.]{0,160}\b(include|add|append|insert|store)\b/i;

export function agentNotesDirectsEnrichment(agentNotes: string | null | undefined): boolean {
  if (!agentNotes) return false;
  return ENRICHMENT_TRIGGER_PATTERN.test(agentNotes);
}
