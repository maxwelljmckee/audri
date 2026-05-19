// Knob catalog — flattened App Map view of every tunable knob across a
// user's agents, with current effective values resolved (override merged
// over KnobSpec default). Consumed by:
//   - apps/server/src/calls/preload.ts → fetches the catalog into the
//     Live Agent prompt's Behavioral layer (App Map segment).
//   - apps/worker/src/ingestion/settings-specialist.ts → uses the catalog
//     to teach Flash which knob-mutation operations are valid + how to
//     map user phrasings via match_hints.
//
// Single source for this query so server + worker stay in sync. The
// fetcher pulls the user's live agents (non-tombstoned), joins
// user_agent_settings.overrides, and enumerates each agent type's
// declared knobs from AGENT_KNOB_REGISTRY.

import { agents, and, eq, isNull, userAgentSettings } from '../db/index.js';
import type { db as DbClient } from '../db/index.js';
import { knobsForAgentType } from './registry.js';
import { resolveKnobValue } from './spec.js';

export interface KnobCatalogEntry {
  agent_id: string;
  agent_name: string;
  agent_type: 'live' | 'ingestion';
  knob_name: string;
  knob_display_name: string;
  knob_description: string;
  current_value: string | boolean;
  current_value_display_name: string;
  values: Array<{
    value: string | boolean;
    display_name: string;
    description: string;
    match_hints: string[];
  }>;
}

export async function fetchKnobCatalog(
  db: typeof DbClient,
  userId: string,
): Promise<KnobCatalogEntry[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      type: agents.type,
      overrides: userAgentSettings.overrides,
    })
    .from(agents)
    .leftJoin(
      userAgentSettings,
      and(
        eq(userAgentSettings.userId, userId),
        eq(userAgentSettings.agentId, agents.id),
      ),
    )
    .where(and(eq(agents.userId, userId), isNull(agents.tombstonedAt)));

  const out: KnobCatalogEntry[] = [];
  for (const r of rows) {
    const knobs = knobsForAgentType(r.type as 'live' | 'ingestion');
    if (knobs.length === 0) continue;
    const overrides = (r.overrides as Record<string, unknown> | null) ?? null;
    for (const spec of knobs) {
      if (!spec.user_visible) continue;
      const current = resolveKnobValue(spec, overrides);
      out.push({
        agent_id: r.id,
        agent_name: r.name,
        agent_type: r.type as 'live' | 'ingestion',
        knob_name: spec.name,
        knob_display_name: spec.display_name,
        knob_description: spec.description,
        current_value: current.value,
        current_value_display_name: current.display_name,
        values: spec.values.map((v) => ({
          value: v.value,
          display_name: v.display_name,
          description: v.description,
          match_hints: v.match_hints ?? [],
        })),
      });
    }
  }
  return out;
}
