// Settings specialist — captures user customization directives from
// transcripts into `user_custom_rules`. Pre-Pro helper that runs in
// parallel with Pro fan-out (same architectural pattern as enrichment-
// lookup; see `project_pre_pro_pipeline_pattern` memory).
//
// Flow:
//   1. Heuristic detector scans user turns for rule-set / rule-update /
//      rule-delete phrasing. Cheap regex; no inference. Bias toward firing —
//      false positive = one wasted Flash call, false negative = silent
//      loss of the user's intent.
//   2. If detector matches: fetch the user's existing active rules (with
//      IDs + page slugs for page-scope rules) and pass them into a Flash
//      inference with structured output. Flash emits OPERATIONS — insert
//      (new rule), update (rewrite an existing rule's content), or delete
//      (soft-delete via is_active=false). Operations may reference
//      existing rules by their internal UUID; Flash resolves the user's
//      verbal reference ("forget about the terseness rule") to the right
//      target_rule_id.
//   3. Commit step applies each operation. Inserts resolve page slugs
//      to wiki_page_ids; updates rewrite content; deletes flip is_active.
//      All operations in a single transaction.
//
// Settings specialist is the SOLE write path for `user_custom_rules` from
// transcripts. Pro fan-out's old agent_notes capture clauses are dead.
//
// Architectural note: deterministic-trigger + bounded-LLM helper, not an
// agentic loop. Detector → single Flash call → commit. No iteration, no
// tool use. Per spec § 5 settings specialist contract + § 6 pre-Pro
// helper pattern.

import {
  and,
  db,
  eq,
  inArray,
  isNull,
  sql,
  userAgentSettings,
  userCustomRules,
  wikiPages,
} from '@audri/shared/db';
import { getGeminiClient } from '@audri/shared/gemini';
import type { KnobCatalogEntry } from '@audri/shared/knobs';
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
// contain rule-shaped phrasing while explaining capabilities; ignoring
// those avoids false-positive detection). Bias toward firing — a Flash
// call costs ~$0.001 and short-circuits when extraction returns no
// operations.
//
// Three families of intent:
//   - INSERT / new rule (rule-shaped): "from now on", "always",
//     "going forward", "default to", "whenever", "by default", "never",
//     "i want you to"
//   - UPDATE / DELETE: "forget", "no longer", "stop doing", "drop the
//     rule", "remove the rule", "change my X rule", "update my X rule",
//     "instead of"
//   - LOOSE DIRECTIVES (impulsive preference statements): "please don't",
//     "be more X", "be less X", "don't be so X", "stop being".
//     Most natural rule-shaped speech doesn't use "from now on"/"always";
//     users just state a preference in the moment. Catching these is what
//     lets the Live Agent's proactive contradiction-detection actually
//     fire — without them, "please don't be so verbose" wouldn't trigger
//     the specialist at all, so any contradiction with an existing rule
//     would silently slip past.
const SETTINGS_TRIGGER_PATTERN =
  /\b(from now on|going forward|from here on|whenever|every time|default to|by default|going to be|always (do|don'?t|use|favor|prefer|cite|include|skip|ask|confirm|check|search|look)|i want you to|never|forget|no longer|stop (doing|always|being)|drop the|remove the|change (my|the) rule|update (my|the) rule|instead of|please don'?t|be (more|less)|don'?t be so)\b/i;

export function detectsSettingsDirectivesHeuristic(
  transcript: IngestionTranscriptTurn[],
): boolean {
  for (const turn of transcript) {
    if (turn.role !== 'user') continue;
    if (SETTINGS_TRIGGER_PATTERN.test(turn.text)) return true;
  }
  return false;
}

// Operation emitted by Flash. Field semantics depend on `operation`:
//   - insert: scope + content required; target_slug required when scope='page'
//   - update: target_rule_id + new_content required
//   - delete: target_rule_id required
//   - set_knob: target_agent_id + knob_name + knob_value required
//   - unset_knob: target_agent_id + knob_name required (reverts to spec default)
// All other fields ignored on a given operation type.
export interface ExtractedOperation {
  operation: 'insert' | 'update' | 'delete' | 'set_knob' | 'unset_knob';
  // INSERT fields
  scope?: 'app' | 'agent' | 'page';
  target_slug?: string | null;
  content?: string;
  // UPDATE / DELETE fields (rule-targeting)
  target_rule_id?: string;
  // UPDATE fields
  new_content?: string;
  // SET_KNOB / UNSET_KNOB fields
  target_agent_id?: string;
  knob_name?: string;
  // SET_KNOB only
  knob_value?: string | boolean;
}

interface ExtractionResult {
  operations: ExtractedOperation[];
}

export interface SettingsSpecialistInput {
  userId: string;
  agentId: string;
  callTranscriptId: string;
  // Full transcript, all roles. Specialist scans user turns for rule
  // directives and reads agent turns for confirmation context.
  transcript: IngestionTranscriptTurn[];
  // Candidate slugs Flash can use for scope='page' target resolution on
  // INSERTs. Specialist looks up wiki_page_ids server-side before insert.
  // Page IDs intentionally NOT exposed to the model.
  candidatePageSlugs: string[];
  // App Map view of tunable knobs across the user's agents. Specialist
  // uses this to (a) teach Flash what knob operations are valid + values,
  // (b) validate set_knob operations against the canonical knob set
  // before writing. Empty when the user has no tunable knobs (early seed).
  knobCatalog: KnobCatalogEntry[];
}

export interface SettingsSpecialistResult {
  rulesInserted: number;
  rulesUpdated: number;
  rulesDeleted: number;
  knobsSet: number;
  knobsUnset: number;
  operationsDropped: number;
}

// Existing rule row as Flash sees it. ID is exposed to the model so it
// can emit target_rule_id on UPDATE / DELETE operations; UUIDs are opaque.
// Page slug joined so Flash can reason about "which reading-list rule".
interface ExistingRuleForFlash {
  id: string;
  scope: 'app' | 'agent' | 'page';
  page_slug?: string | null;
  content: string;
}

function buildSystemPrompt(): string {
  return `You are a settings-rule extractor. Given a voice transcript between a user and a personal-assistant agent — plus the user's current active rules and tunable knob catalog — extract any OPERATIONS the USER directed on their customization rules OR their tunable knobs.

# Operation types

There are TWO families of operations:

**Rule operations** (modify free-form natural-language rules in user_custom_rules):
- **insert** — user states a new recurring rule that doesn't conflict with existing ones, or chooses to add a more specific rule alongside an existing broader one ("be terse generally, but on Consensus be expansive" — the second clause is an insert at narrower scope).
- **update** — user rewrites the content of an existing rule. Use this when the user wants to KEEP the rule at its current scope but change its content ("change my reading-list rule to also include the premise"). Requires target_rule_id.
- **delete** — user explicitly wants an existing rule gone. Triggers: "forget", "no longer", "stop doing", "drop the rule", "remove the rule". Requires target_rule_id.

**Knob operations** (modify discrete agent settings in user_agent_settings.overrides):
- **set_knob** — user wants a specific tunable setting changed to a specific value. The available knobs + their values appear in the input below under "Current tunable knobs"; match the user's phrasing to a knob value via its match_hints. Requires target_agent_id, knob_name, knob_value. Knob_value must exactly match one of the listed values for that knob.
- **unset_knob** — user wants to revert a knob to its default ("go back to the default Intelligence setting"). Requires target_agent_id + knob_name.

**Knob vs. rule — which to emit:** When the user states a directive, check the knob catalog FIRST. If the directive maps cleanly to a knob value (via match_hints or semantic similarity), emit **set_knob**. If not, emit a rule operation. Example: "be more thorough" → matches Intelligence's High value via match_hints — emit set_knob. "Always cite sources when stating facts" → no matching knob — emit insert (custom rule).

# Rule scopes (for inserts)

- **app** — applies across every agent the user has. Examples: "Always cite your sources." "Never use emojis unless I use one first."
- **agent** — applies to the specific agent the user is talking to. Examples: "Default to terse responses." "Don't ask me to confirm before adding todos."
- **page** — applies to a specific wiki page. MUST identify the page by name; extracted target_slug must match one of the provided candidate slugs.

# What counts as a directive

A directive that establishes / modifies / removes recurring future behavior. Trigger phrases include "from now on", "always", "going forward", "whenever", "default to", "from here on out" (insert family); "forget", "no longer", "stop doing", "drop the rule", "instead of" (update / delete family).

# What does NOT count

- **One-off actions.** "Remind me to call mom" is a todo, not a rule.
- **Past-tense / present-tense observations.** "I always wake up at 6" is the user describing themselves.
- **The agent's own forward-looking statements.** Only USER directives count.
- **In-call instructions for THIS call only.** "Just for this conversation, be more terse" is not a recurring rule.

# Output contract

Emit one entry per distinct operation. If the user states no directives, emit \`{ "operations": [] }\` — empty is fine and the most common case.

Field semantics by operation type:
- **insert:** \`scope\` ('app' | 'agent' | 'page'), \`content\` (clean third-person imperative). \`target_slug\` required when scope='page' and must match a candidate slug. Other fields null.
- **update:** \`target_rule_id\` (the UUID of an existing rule), \`new_content\`. Other fields null. Scope is preserved.
- **delete:** \`target_rule_id\`. Other fields null.
- **set_knob:** \`target_agent_id\` (the UUID of the agent whose knob changes), \`knob_name\` (snake_case key from the catalog), \`knob_value\` (one of the values listed for that knob — strings only in current schema). Other fields null.
- **unset_knob:** \`target_agent_id\`, \`knob_name\`. Other fields null.

# Matching the user's verbal reference to a rule ID

When the user references an existing rule for update or delete, you'll see the current rules in the input. Match the user's verbal reference ("my terseness rule", "the reading-list lookup rule") to the most semantically appropriate rule and emit its \`id\` as \`target_rule_id\`. If the reference is ambiguous between two rules or doesn't clearly match any, drop the operation rather than guess wrong.

# Contradiction handling

The Live Agent is prompted to PROACTIVELY surface contradictions when a user's directive conflicts with a standing rule — most users don't remember their accumulated ruleset and speak preferences impulsively. By the time you see the transcript, one of three things happened:

1. **The Live Agent surfaced the contradiction and the user picked a resolution.** Look for a back-and-forth where the agent named an existing rule and the user responded. Extract their choice:
   - User said "yes, replace it" / "actually let me rewrite that" / "refine it" → \`update\` on the existing rule with the new content.
   - User said "keep the broad one, add the more specific" / "scope it down" / "just for [page/context]" → \`insert\` at narrower scope; existing rule stays untouched.
   - User said "forget the existing rule" / "delete it" / "no longer needed" → \`delete\`.
   - User said "actually just for this call" / "never mind" → emit NO operation. The contradiction was a one-call deflection.

2. **The Live Agent didn't catch the contradiction (regex/judgment slip), but you can see it in the transcript.** Trust the user's directive as the source of truth. The contradiction-detection should have happened mid-call; since it didn't, the safe move is \`insert\` (add the new rule) and let read-time precedence (page > agent > app) resolve the conflict. **Do NOT silently update/delete an existing rule the user didn't explicitly address** — that violates user consent.

3. **No contradiction.** Standard insert/update/delete handling per the user's directive.

# Examples

User says: "From now on always cite sources when stating facts."
→ \`{ operations: [{ operation: "insert", scope: "app", content: "Always cite sources when stating factual information." }] }\`

User says: "Change my reading-list rule to also include the premise."
(Existing rule with id="abc-123" content="When adding a book, look up author + year.")
→ \`{ operations: [{ operation: "update", target_rule_id: "abc-123", new_content: "When adding a book, look up author, year, and a one-sentence premise." }] }\`

User says: "Forget about the terseness rule."
(Existing rule with id="def-456" scope="agent" content="Default to terse responses.")
→ \`{ operations: [{ operation: "delete", target_rule_id: "def-456" }] }\`

User says: "Keep my agent-wide terseness, but on Consensus give me expansive explanations."
(Existing agent-scope terseness rule remains untouched.)
→ \`{ operations: [{ operation: "insert", scope: "page", target_slug: "consensus", content: "When discussing this project, prefer expansive explanations over the default terse register." }] }\`

User says: "Be more thorough with my notes."
(Knob catalog has Rumi's intelligence knob with high value matching "thorough" via match_hints.)
→ \`{ operations: [{ operation: "set_knob", target_agent_id: "<rumi-uuid>", knob_name: "intelligence", knob_value: "high" }] }\`

User says: "Go back to the default Intelligence."
→ \`{ operations: [{ operation: "unset_knob", target_agent_id: "<rumi-uuid>", knob_name: "intelligence" }] }\`

User says: "Just take a note about that." (no rule content)
→ \`{ operations: [] }\`

Be conservative — when uncertain whether a directive is a rule operation vs a one-off action, prefer to skip.`;
}

function buildUserMessage(
  opts: SettingsSpecialistInput,
  existingRules: ExistingRuleForFlash[],
): string {
  const transcriptText = opts.transcript.map((t) => `[${t.role}] ${t.text}`).join('\n');
  const candidatesBlock =
    opts.candidatePageSlugs.length === 0
      ? '(none)'
      : opts.candidatePageSlugs.map((s) => `- ${s}`).join('\n');
  const rulesBlock =
    existingRules.length === 0
      ? '(none — user has no active rules yet)'
      : existingRules
          .map((r) => {
            const scopeNote =
              r.scope === 'page' && r.page_slug ? `page='${r.page_slug}'` : r.scope;
            return `- id=${r.id} (${scopeNote}): ${r.content}`;
          })
          .join('\n');

  // Knob catalog: render flat list grouped by agent. Match_hints carried
  // so Flash can recognize user phrasings that don't literally match a
  // value name. Current value shown so Flash can avoid emitting redundant
  // set_knob operations (no-op writes).
  let knobsBlock: string;
  if (opts.knobCatalog.length === 0) {
    knobsBlock = '(none — user has no tunable knobs yet)';
  } else {
    const byAgent = new Map<string, KnobCatalogEntry[]>();
    for (const k of opts.knobCatalog) {
      const list = byAgent.get(k.agent_id) ?? [];
      list.push(k);
      byAgent.set(k.agent_id, list);
    }
    const sections: string[] = [];
    for (const [, knobs] of byAgent) {
      const head = knobs[0];
      if (!head) continue;
      sections.push(`Agent: ${head.agent_name} (id=${head.agent_id}, type=${head.agent_type})`);
      for (const k of knobs) {
        sections.push(`  - knob_name=${k.knob_name} (${k.knob_display_name})`);
        sections.push(`    current_value=${String(k.current_value)} (${k.current_value_display_name})`);
        sections.push(`    description: ${k.knob_description}`);
        sections.push('    values:');
        for (const v of k.values) {
          const hints = v.match_hints.length > 0 ? ` [hints: ${v.match_hints.join(', ')}]` : '';
          sections.push(`      - ${String(v.value)} (${v.display_name}): ${v.description}${hints}`);
        }
      }
    }
    knobsBlock = sections.join('\n');
  }

  return `# Candidate page slugs (use these for scope='page' target_slug on rule inserts)
${candidatesBlock}

# Current active rules (reference these by id for rule update / delete operations)
${rulesBlock}

# Current tunable knobs (reference target_agent_id + knob_name + knob_value for set_knob / unset_knob operations)
${knobsBlock}

# Transcript
${transcriptText}`;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    operations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          operation: {
            type: Type.STRING,
            enum: ['insert', 'update', 'delete', 'set_knob', 'unset_knob'],
          },
          // RULE op fields
          scope: { type: Type.STRING, enum: ['app', 'agent', 'page'], nullable: true },
          target_slug: { type: Type.STRING, nullable: true },
          content: { type: Type.STRING, nullable: true },
          target_rule_id: { type: Type.STRING, nullable: true },
          new_content: { type: Type.STRING, nullable: true },
          // KNOB op fields
          target_agent_id: { type: Type.STRING, nullable: true },
          knob_name: { type: Type.STRING, nullable: true },
          // Knob values are strings in v0.4.0 (enum knobs only — no booleans
          // declared yet). When boolean knobs land, the schema needs to allow
          // boolean here. Today, string-only keeps the schema simple.
          knob_value: { type: Type.STRING, nullable: true },
        },
        required: ['operation'],
      },
    },
  },
  required: ['operations'],
};

async function fetchExistingRules(
  userId: string,
  agentId: string,
): Promise<ExistingRuleForFlash[]> {
  // Pull every active rule the agent could be modifying:
  //   - all app-scope rules for this user
  //   - agent-scope rules tied to THIS agent (not other agents the user has)
  //   - all page-scope rules for this user, joined with page slug
  // Plugin-scope rules excluded (reserved enum value; not wired).
  const rows = await db
    .select({
      id: userCustomRules.id,
      scope: userCustomRules.scope,
      agentId: userCustomRules.agentId,
      wikiPageId: userCustomRules.wikiPageId,
      pageSlug: wikiPages.slug,
      content: userCustomRules.content,
    })
    .from(userCustomRules)
    .leftJoin(wikiPages, eq(userCustomRules.wikiPageId, wikiPages.id))
    .where(
      and(
        eq(userCustomRules.userId, userId),
        eq(userCustomRules.isActive, true),
      ),
    );

  const filtered: ExistingRuleForFlash[] = [];
  for (const r of rows) {
    // Skip agent-scope rules tied to OTHER agents (not addressable from this call).
    if (r.scope === 'agent' && r.agentId !== agentId) continue;
    // Skip plugin-scope (reserved; not wired in v0.4.0).
    if (r.scope !== 'app' && r.scope !== 'agent' && r.scope !== 'page') continue;
    filtered.push({
      id: r.id,
      scope: r.scope,
      page_slug: r.scope === 'page' ? r.pageSlug : null,
      content: r.content,
    });
  }
  return filtered;
}

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
        inArray(wikiPages.slug, slugs),
      ),
    );
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.slug, r.id);
  return map;
}

export async function runSettingsSpecialist(
  opts: SettingsSpecialistInput,
): Promise<SettingsSpecialistResult> {
  const startedAt = Date.now();
  const emptyResult: SettingsSpecialistResult = {
    rulesInserted: 0,
    rulesUpdated: 0,
    rulesDeleted: 0,
    knobsSet: 0,
    knobsUnset: 0,
    operationsDropped: 0,
  };

  if (!detectsSettingsDirectivesHeuristic(opts.transcript)) {
    return emptyResult;
  }

  // Fetch existing rules in parallel with the inference call setup (small
  // win; could parallelize further with the transcript scan above if it
  // ever matters).
  const existingRules = await fetchExistingRules(opts.userId, opts.agentId);

  let extracted: ExtractionResult;
  try {
    const resp = await getGeminiClient().models.generateContent({
      model: FLASH_MODEL,
      contents: [
        { role: 'user', parts: [{ text: buildUserMessage(opts, existingRules) }] },
      ],
      config: {
        systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
        abortSignal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });

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

    const text = resp.text ?? '{"operations":[]}';
    try {
      extracted = JSON.parse(text) as ExtractionResult;
    } catch {
      logger.warn(
        { textLength: text.length, callTranscriptId: opts.callTranscriptId },
        'settings-specialist: JSON parse failed; treating as no operations',
      );
      return emptyResult;
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
    return emptyResult;
  }

  if (!extracted.operations || extracted.operations.length === 0) {
    logger.info(
      { callTranscriptId: opts.callTranscriptId, totalMs: Date.now() - startedAt },
      'settings-specialist: heuristic fired but Flash found no operations',
    );
    return emptyResult;
  }

  // Sort operations into insert / update / delete / set_knob / unset_knob
  // buckets, validating each operation's required fields. Operations missing
  // their required fields drop with a warning.
  const inserts: Array<{
    scope: 'app' | 'agent' | 'page';
    agentId: string | null;
    wikiPageId: string | null;
    content: string;
  }> = [];
  const updates: Array<{ id: string; newContent: string }> = [];
  const deletes: string[] = [];
  // Knob ops grouped by agent_id so we can collapse multiple operations
  // for the same agent into a single JSONB write at commit time.
  const knobSetsByAgent = new Map<string, Record<string, string | boolean>>();
  const knobUnsetsByAgent = new Map<string, Set<string>>();
  let dropped = 0;

  // For inserts at scope='page', collect slugs upfront and resolve in one query.
  const pageSlugsNeeded = new Set<string>();
  for (const op of extracted.operations) {
    if (op.operation === 'insert' && op.scope === 'page' && op.target_slug) {
      pageSlugsNeeded.add(op.target_slug);
    }
  }
  const pageSlugToId = await fetchSlugIdMap(opts.userId, Array.from(pageSlugsNeeded));

  // Existing rule IDs to validate update / delete target references.
  const existingRuleIds = new Set(existingRules.map((r) => r.id));

  // Knob catalog index for validation. Maps "<agent_id>:<knob_name>" to
  // the allowed values for that knob — set_knob ops are validated against
  // this before committing. Prevents Flash from emitting bogus knob names
  // or values that don't exist on the spec.
  const knobCatalogIndex = new Map<string, Set<string | boolean>>();
  for (const k of opts.knobCatalog) {
    knobCatalogIndex.set(
      `${k.agent_id}:${k.knob_name}`,
      new Set(k.values.map((v) => v.value)),
    );
  }

  for (const op of extracted.operations) {
    if (op.operation === 'insert') {
      if (!op.scope || !op.content) {
        logger.warn(
          { op, callTranscriptId: opts.callTranscriptId },
          'settings-specialist: insert missing scope or content — dropped',
        );
        dropped++;
        continue;
      }
      if (op.scope === 'app') {
        inserts.push({ scope: 'app', agentId: null, wikiPageId: null, content: op.content });
      } else if (op.scope === 'agent') {
        inserts.push({
          scope: 'agent',
          agentId: opts.agentId,
          wikiPageId: null,
          content: op.content,
        });
      } else if (op.scope === 'page') {
        const slug = op.target_slug ?? '';
        const wikiPageId = pageSlugToId.get(slug);
        if (!wikiPageId) {
          logger.warn(
            { op, slug, callTranscriptId: opts.callTranscriptId },
            'settings-specialist: insert page target not found — dropped',
          );
          dropped++;
          continue;
        }
        inserts.push({ scope: 'page', agentId: null, wikiPageId, content: op.content });
      } else {
        logger.warn({ op }, 'settings-specialist: insert unknown scope — dropped');
        dropped++;
      }
    } else if (op.operation === 'update') {
      if (!op.target_rule_id || !op.new_content) {
        logger.warn(
          { op, callTranscriptId: opts.callTranscriptId },
          'settings-specialist: update missing target_rule_id or new_content — dropped',
        );
        dropped++;
        continue;
      }
      if (!existingRuleIds.has(op.target_rule_id)) {
        logger.warn(
          { op, callTranscriptId: opts.callTranscriptId },
          'settings-specialist: update target_rule_id not in user rules — dropped',
        );
        dropped++;
        continue;
      }
      updates.push({ id: op.target_rule_id, newContent: op.new_content });
    } else if (op.operation === 'delete') {
      if (!op.target_rule_id) {
        logger.warn(
          { op, callTranscriptId: opts.callTranscriptId },
          'settings-specialist: delete missing target_rule_id — dropped',
        );
        dropped++;
        continue;
      }
      if (!existingRuleIds.has(op.target_rule_id)) {
        logger.warn(
          { op, callTranscriptId: opts.callTranscriptId },
          'settings-specialist: delete target_rule_id not in user rules — dropped',
        );
        dropped++;
        continue;
      }
      deletes.push(op.target_rule_id);
    } else if (op.operation === 'set_knob') {
      if (!op.target_agent_id || !op.knob_name || op.knob_value === undefined || op.knob_value === null) {
        logger.warn(
          { op, callTranscriptId: opts.callTranscriptId },
          'settings-specialist: set_knob missing target_agent_id / knob_name / knob_value — dropped',
        );
        dropped++;
        continue;
      }
      const allowedValues = knobCatalogIndex.get(`${op.target_agent_id}:${op.knob_name}`);
      if (!allowedValues) {
        logger.warn(
          { op, callTranscriptId: opts.callTranscriptId },
          'settings-specialist: set_knob target agent/knob not in catalog — dropped',
        );
        dropped++;
        continue;
      }
      if (!allowedValues.has(op.knob_value)) {
        logger.warn(
          { op, allowedValues: Array.from(allowedValues), callTranscriptId: opts.callTranscriptId },
          'settings-specialist: set_knob value not in spec — dropped',
        );
        dropped++;
        continue;
      }
      const bucket = knobSetsByAgent.get(op.target_agent_id) ?? {};
      bucket[op.knob_name] = op.knob_value;
      knobSetsByAgent.set(op.target_agent_id, bucket);
    } else if (op.operation === 'unset_knob') {
      if (!op.target_agent_id || !op.knob_name) {
        logger.warn(
          { op, callTranscriptId: opts.callTranscriptId },
          'settings-specialist: unset_knob missing target_agent_id or knob_name — dropped',
        );
        dropped++;
        continue;
      }
      const allowed = knobCatalogIndex.has(`${op.target_agent_id}:${op.knob_name}`);
      if (!allowed) {
        logger.warn(
          { op, callTranscriptId: opts.callTranscriptId },
          'settings-specialist: unset_knob target agent/knob not in catalog — dropped',
        );
        dropped++;
        continue;
      }
      const bucket = knobUnsetsByAgent.get(op.target_agent_id) ?? new Set<string>();
      bucket.add(op.knob_name);
      knobUnsetsByAgent.set(op.target_agent_id, bucket);
    }
  }

  const totalOps =
    inserts.length +
    updates.length +
    deletes.length +
    knobSetsByAgent.size +
    knobUnsetsByAgent.size;
  if (totalOps === 0) {
    logger.info(
      { dropped, callTranscriptId: opts.callTranscriptId },
      'settings-specialist: all operations dropped; nothing committed',
    );
    return { ...emptyResult, operationsDropped: dropped };
  }

  // Apply in one transaction. Order:
  //   1. rule deletes (clear the field for contradicting rules)
  //   2. rule updates
  //   3. rule inserts
  //   4. knob writes (per-agent JSONB upsert: merge sets, drop unsets)
  // All in one tx so a partial failure leaves nothing behind.
  let knobsSet = 0;
  let knobsUnset = 0;
  try {
    await db.transaction(async (tx) => {
      if (deletes.length > 0) {
        await tx
          .update(userCustomRules)
          .set({ isActive: false, updatedAt: new Date() })
          .where(inArray(userCustomRules.id, deletes));
      }
      for (const u of updates) {
        await tx
          .update(userCustomRules)
          .set({ content: u.newContent, updatedAt: new Date() })
          .where(eq(userCustomRules.id, u.id));
      }
      if (inserts.length > 0) {
        await tx.insert(userCustomRules).values(
          inserts.map((r) => ({
            userId: opts.userId,
            scope: r.scope,
            agentId: r.agentId,
            wikiPageId: r.wikiPageId,
            content: r.content,
            source: 'user_set' as const,
          })),
        );
      }

      // Knob writes — per-agent JSONB upsert. For each agent with knob
      // mutations, compute the resulting overrides object (merge sets
      // over current, drop unsets) and upsert the user_agent_settings
      // row. SELECT-then-UPSERT inside the tx so concurrent writes are
      // serialized by the row lock.
      const agentsAffected = new Set<string>([
        ...knobSetsByAgent.keys(),
        ...knobUnsetsByAgent.keys(),
      ]);
      for (const agentId of agentsAffected) {
        const [existing] = await tx
          .select({ overrides: userAgentSettings.overrides })
          .from(userAgentSettings)
          .where(
            and(
              eq(userAgentSettings.userId, opts.userId),
              eq(userAgentSettings.agentId, agentId),
            ),
          )
          .limit(1);
        // Build the final merged overrides object. Process unsets first
        // so a stray set + unset on the same knob ends up SET (defensive
        // against Flash emitting both for the same key).
        let working: Record<string, unknown> = {
          ...((existing?.overrides as Record<string, unknown> | undefined) ?? {}),
        };
        const unsets = knobUnsetsByAgent.get(agentId);
        if (unsets) {
          for (const knobName of unsets) {
            if (knobName in working) {
              const { [knobName]: _dropped, ...rest } = working;
              working = rest;
              knobsUnset++;
            }
          }
        }
        const sets = knobSetsByAgent.get(agentId);
        if (sets) {
          for (const [knobName, knobValue] of Object.entries(sets)) {
            working[knobName] = knobValue;
            knobsSet++;
          }
        }
        // UPSERT the row with the merged overrides object.
        await tx
          .insert(userAgentSettings)
          .values({
            userId: opts.userId,
            agentId,
            overrides: working,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [userAgentSettings.userId, userAgentSettings.agentId],
            set: { overrides: working, updatedAt: new Date() },
          });
      }
    });
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        inserts: inserts.length,
        updates: updates.length,
        deletes: deletes.length,
        knobSetsByAgent: knobSetsByAgent.size,
        knobUnsetsByAgent: knobUnsetsByAgent.size,
        callTranscriptId: opts.callTranscriptId,
      },
      'settings-specialist: transaction failed — operations NOT committed',
    );
    return { ...emptyResult, operationsDropped: dropped };
  }

  const result: SettingsSpecialistResult = {
    rulesInserted: inserts.length,
    rulesUpdated: updates.length,
    rulesDeleted: deletes.length,
    knobsSet,
    knobsUnset,
    operationsDropped: dropped,
  };
  logger.info(
    {
      callTranscriptId: opts.callTranscriptId,
      ...result,
      totalMs: Date.now() - startedAt,
    },
    'settings-specialist: complete',
  );
  return result;
}
