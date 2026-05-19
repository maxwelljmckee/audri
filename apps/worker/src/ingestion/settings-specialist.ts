// Settings specialist — captures user customization directives from
// transcripts into `user_custom_rules`. Pre-Pro helper that runs in
// parallel with Pro fan-out (same architectural pattern as enrichment-
// lookup; see `project_pre_pro_pipeline_pattern` memory).
//
// Flow:
//   1. Heuristic detector scans user turns for recurring-rule phrasing
//      ("from now on", "always", "going forward", "default to", etc.).
//      Cheap regex; no inference. Bias toward firing — false positive =
//      one wasted Flash call, false negative = silent loss of the user's
//      intent.
//   2. If detector matches: Flash inference with structured output
//      extracts each rule into { scope, target_slug?, content }.
//   3. Commit step resolves page targets to wiki_page_ids (using the
//      Flash candidate retrieval's touched/new pages map) and inserts
//      `user_custom_rules` rows.
//
// Settings specialist is the SOLE write path for `user_custom_rules` from
// transcripts. Pro fan-out's old agent_notes capture clauses are dead —
// agent_notes removed from responseSchema in the same commit that
// introduced this module. Pro stays narrow (notes-only).
//
// Architectural note: this is a deterministic-trigger + bounded-LLM
// helper, not an agentic loop. Detector → single Flash call → commit.
// No iteration, no tool use. Per spec § 5 settings specialist contract +
// § 6 pre-Pro helper pattern.

import { and, db, eq, isNull, userCustomRules, wikiPages } from '@audri/shared/db';
import { getGeminiClient } from '@audri/shared/gemini';
import { recordInferenceUsage } from '@audri/shared/usage';
import { Type } from '@google/genai';
import type { IngestionTranscriptTurn } from './flash-candidate-retrieval.js';
import { logger } from '../logger.js';

const FLASH_MODEL = 'gemini-2.5-flash';

// Wallclock budget for one extraction call. Flash + structured output is
// fast (~2-5s typical). 30s is generous; abort beyond.
const EXTRACTION_TIMEOUT_MS = Number(
  process.env.SETTINGS_SPECIALIST_TIMEOUT_MS ?? 30_000,
);

// Heuristic detector. Scans USER turns only (the agent's own turns may
// contain "from now on" while explaining capabilities; ignoring those
// avoids false-positive detection). Bias toward firing — a Flash call
// costs ~$0.001 and short-circuits when extraction returns [].
//
// Phrases caught (case-insensitive, word-boundary): "from now on",
// "always" (when paired with a verb), "going forward", "from here on
// out", "whenever", "every time", "default to", "by default", "going
// to be", "I want you to" (forward-looking instruction shape).
const SETTINGS_TRIGGER_PATTERN =
  /\b(from now on|going forward|from here on|whenever|every time|default to|by default|going to be|always (do|don'?t|use|favor|prefer|cite|include|skip|ask|confirm|check|search|look)|i want you to|never)\b/i;

export function detectsSettingsDirectivesHeuristic(
  transcript: IngestionTranscriptTurn[],
): boolean {
  for (const turn of transcript) {
    if (turn.role !== 'user') continue;
    if (SETTINGS_TRIGGER_PATTERN.test(turn.text)) return true;
  }
  return false;
}

export interface ExtractedRule {
  scope: 'app' | 'agent' | 'page';
  target_slug?: string | null;
  content: string;
}

interface ExtractionResult {
  rules: ExtractedRule[];
}

export interface SettingsSpecialistInput {
  userId: string;
  agentId: string;
  callTranscriptId: string;
  // Full transcript, all roles. Specialist scans user turns for rule
  // directives and reads agent turns for confirmation context.
  transcript: IngestionTranscriptTurn[];
  // Candidate slugs to advertise to Flash for scope='page' resolution.
  // Specialist looks up wiki_page_ids server-side via a separate query —
  // page IDs intentionally NOT exposed to the model. Worker can pass any
  // candidate slug set; typically the full wiki-index slug list, or the
  // Flash retrieval candidate set if narrower precision is needed.
  candidatePageSlugs: string[];
}

export interface SettingsSpecialistResult {
  rulesCreated: number;
  // Rules detected by Flash but dropped at commit time (e.g., scope='page'
  // with unresolvable target_slug). Logged for telemetry.
  rulesDropped: number;
}

function buildSystemPrompt(): string {
  return `You are a settings-rule extractor. Given a voice transcript between a user and a personal-assistant agent, extract any recurring rules the USER set for how their agents should behave.

# Rule scopes

- **app** — applies across every agent the user has. Examples: "Always cite your sources." "Never use emojis unless I use one first." "When you give me facts, include the year."
- **agent** — applies to the specific agent the user is talking to. Examples: "When you research, default to one-paragraph summaries." "Don't ask me to confirm before adding todos." (The agent is the recipient of these rules by virtue of being addressed.)
- **page** — applies to a specific wiki page the user owns. Examples: "On my reading list, look up the author and year when I add a book." "For my Consensus project, always link new sections back to the goals doc." A page-scope rule MUST identify a wiki page by name; the extracted \`target_slug\` must be a slug from the provided page list.

# What counts as a rule

A directive that establishes recurring future behavior. Trigger phrases include "from now on", "always", "going forward", "whenever", "every time", "default to", "by default", "from here on out".

# What does NOT count as a rule

- **One-off actions.** "Remind me to call mom" is a todo, not a rule.
- **Past-tense / present-tense observations.** "I always wake up at 6" is the user describing themselves, not setting a rule for the agent.
- **The agent's own forward-looking statements.** Only USER directives count — if the agent says "I'll always do X going forward," that's the agent's commitment, not a user rule.
- **In-call instructions for THIS call only.** "Just for this conversation, be more terse" is not a recurring rule.

# Output contract

Emit one entry per distinct rule. If the user states no rules, emit \`{ "rules": [] }\` — empty is fine and the most common case.

Fields:
- \`scope\`: 'app' | 'agent' | 'page'
- \`target_slug\`: string (required when scope='page'; must match one of the candidate slugs provided); null otherwise.
- \`content\`: a clean, concise statement of the rule in third-person imperative ("Always cite sources when giving facts." not "you should always cite sources when giving me facts"). 1–2 sentences max. Past-tense user phrasing should be reframed as standing instruction.

# Examples

User says: "Hey from now on, always cite sources when you tell me something factual."
→ \`{ scope: "app", content: "Always cite sources when stating factual information." }\`

User says: "On my reading list page, whenever I add a book, please look up the author and the year."
→ \`{ scope: "page", target_slug: "reading-list", content: "When adding a book to this list, look up the author and the publication year and include them on the new page." }\`

User says: "When you do research for me, always include a one-line summary at the top."
→ \`{ scope: "agent", content: "When producing research outputs, lead with a one-line summary at the top." }\`

User says: "Remind me to call mom this weekend."
→ \`{ rules: [] }\` (one-off todo, not a recurring rule)

User says: "I just want to think out loud for a sec." (no rule content)
→ \`{ rules: [] }\`

Multiple distinct rules in one transcript → multiple entries in the rules array.

Be conservative: when a directive is ambiguous between "one-off" and "recurring," prefer to skip rather than create a false-positive rule.`;
}

function buildUserMessage(opts: SettingsSpecialistInput): string {
  const transcriptText = opts.transcript
    .map((t) => `[${t.role}] ${t.text}`)
    .join('\n');
  return `# Candidate page slugs (use these for scope='page' target_slug)
${opts.candidatePageSlugs.length === 0 ? '(none)' : opts.candidatePageSlugs.map((s) => `- ${s}`).join('\n')}

# Transcript
${transcriptText}`;
}

// Resolve slugs → wiki_page_ids server-side. Filters to non-tombstoned,
// non-archived user-scope pages. Returns a map keyed by slug.
async function fetchSlugIdMap(
  userId: string,
  slugs: string[],
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({ id: wikiPages.id, slug: wikiPages.slug })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.userId, userId),
        eq(wikiPages.scope, 'user'),
        isNull(wikiPages.tombstonedAt),
        isNull(wikiPages.archivedAt),
      ),
    );
  const slugSet = new Set(slugs);
  const map = new Map<string, string>();
  for (const r of rows) {
    if (slugSet.has(r.slug)) map.set(r.slug, r.id);
  }
  return map;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    rules: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          scope: { type: Type.STRING, enum: ['app', 'agent', 'page'] },
          target_slug: { type: Type.STRING, nullable: true },
          content: { type: Type.STRING },
        },
        required: ['scope', 'content'],
      },
    },
  },
  required: ['rules'],
};

export async function runSettingsSpecialist(
  opts: SettingsSpecialistInput,
): Promise<SettingsSpecialistResult> {
  const startedAt = Date.now();

  if (!detectsSettingsDirectivesHeuristic(opts.transcript)) {
    return { rulesCreated: 0, rulesDropped: 0 };
  }

  let extracted: ExtractionResult;
  try {
    const resp = await getGeminiClient().models.generateContent({
      model: FLASH_MODEL,
      contents: [{ role: 'user', parts: [{ text: buildUserMessage(opts) }] }],
      config: {
        systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
        abortSignal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    // Best-effort usage recording. Same kind as enrichment-lookup
    // ('tool_lookup') for now — the table-level analytics split happens
    // later via event_kind/extras taxonomy if needed.
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
        'settings-specialist: usage record failed (non-fatal)',
      );
    });

    const text = resp.text ?? '{"rules":[]}';
    try {
      extracted = JSON.parse(text) as ExtractionResult;
    } catch {
      logger.warn(
        { textLength: text.length, callTranscriptId: opts.callTranscriptId },
        'settings-specialist: JSON parse failed; treating as no rules',
      );
      return { rulesCreated: 0, rulesDropped: 0 };
    }
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        callTranscriptId: opts.callTranscriptId,
        totalMs: Date.now() - startedAt,
      },
      'settings-specialist: Flash extraction failed; ingestion continues',
    );
    return { rulesCreated: 0, rulesDropped: 0 };
  }

  if (!extracted.rules || extracted.rules.length === 0) {
    logger.info(
      { callTranscriptId: opts.callTranscriptId, totalMs: Date.now() - startedAt },
      'settings-specialist: heuristic fired but Flash found no rules',
    );
    return { rulesCreated: 0, rulesDropped: 0 };
  }

  // Resolve page-scope target_slugs to wiki_page_ids. Drop rules whose
  // target isn't in the resolved map — those are slugs Flash hallucinated
  // or that aren't yet committed to the wiki (we don't try to look them
  // up server-side; rule authoring requires the target to exist).
  const pageSlugsNeeded = extracted.rules
    .filter((r) => r.scope === 'page' && r.target_slug)
    .map((r) => r.target_slug as string);
  const pageSlugToId = await fetchSlugIdMap(opts.userId, pageSlugsNeeded);

  const toInsert: Array<{
    scope: 'app' | 'agent' | 'page';
    agentId: string | null;
    wikiPageId: string | null;
    content: string;
  }> = [];
  let dropped = 0;
  for (const rule of extracted.rules) {
    if (rule.scope === 'app') {
      toInsert.push({
        scope: 'app',
        agentId: null,
        wikiPageId: null,
        content: rule.content,
      });
    } else if (rule.scope === 'agent') {
      toInsert.push({
        scope: 'agent',
        agentId: opts.agentId,
        wikiPageId: null,
        content: rule.content,
      });
    } else if (rule.scope === 'page') {
      const slug = rule.target_slug ?? '';
      const wikiPageId = pageSlugToId.get(slug);
      if (!wikiPageId) {
        logger.warn(
          {
            callTranscriptId: opts.callTranscriptId,
            target_slug: slug,
            ruleContent: rule.content,
          },
          'settings-specialist: page-scope rule target not in candidates — dropped',
        );
        dropped++;
        continue;
      }
      toInsert.push({
        scope: 'page',
        agentId: null,
        wikiPageId,
        content: rule.content,
      });
    } else {
      logger.warn(
        { scope: rule.scope, callTranscriptId: opts.callTranscriptId },
        'settings-specialist: unknown scope — dropped',
      );
      dropped++;
    }
  }

  if (toInsert.length === 0) {
    logger.info(
      { dropped, callTranscriptId: opts.callTranscriptId },
      'settings-specialist: all extracted rules dropped; no inserts',
    );
    return { rulesCreated: 0, rulesDropped: dropped };
  }

  try {
    await db.insert(userCustomRules).values(
      toInsert.map((r) => ({
        userId: opts.userId,
        scope: r.scope,
        agentId: r.agentId,
        wikiPageId: r.wikiPageId,
        content: r.content,
        source: 'user_set' as const,
      })),
    );
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        rulesAttempted: toInsert.length,
        callTranscriptId: opts.callTranscriptId,
      },
      'settings-specialist: insert failed — rules NOT committed',
    );
    return { rulesCreated: 0, rulesDropped: dropped };
  }

  logger.info(
    {
      callTranscriptId: opts.callTranscriptId,
      rulesCreated: toInsert.length,
      rulesDropped: dropped,
      totalMs: Date.now() - startedAt,
    },
    'settings-specialist: complete',
  );
  return { rulesCreated: toInsert.length, rulesDropped: dropped };
}
