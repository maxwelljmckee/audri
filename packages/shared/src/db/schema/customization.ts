// Customization framework — `user_custom_rules` (NL overlay) + `user_agent_settings`
// (typed knob overrides). See specs/customization-framework.md § "NL customization
// architecture" for the full design.
//
// Two-layer model:
//   - user_agent_settings — typed knob value overrides, keyed (user_id, agent_id).
//   - user_custom_rules — free-form markdown rules, scoped (app/agent/page/plugin),
//     concatenated into the Behavioral layer of relevant prompts in precedence order.

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './_auth.js';
import { customRuleScopeEnum, customRuleSourceEnum } from './enums.js';
import { agents } from './identity.js';
import { wikiPages } from './wiki.js';

// Natural-language customization rules. Scope hierarchy determines which
// inference sites read the rule:
//   - 'app'    — every inference site for this user
//   - 'agent'  — inferences running on behalf of the specified agent
//   - 'page'   — inferences touching the specified wiki page
//   - 'plugin' — reserved (not wired in v0.4.0)
//
// CHECK constraints enforcing the scope→FK shape live in the hand-edited
// migration (Drizzle's check() helper exists but the constraint form is
// clearer in raw SQL). See migration 0038.
export const userCustomRules = pgTable(
  'user_custom_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    scope: customRuleScopeEnum('scope').notNull(),
    // Required when scope='agent'; NULL otherwise.
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    // Required when scope='page'; NULL otherwise.
    wikiPageId: uuid('wiki_page_id').references(() => wikiPages.id, { onDelete: 'cascade' }),
    // Required when scope='plugin'; NULL otherwise. Identifies the plugin
    // registry entry (text key, not a uuid FK — plugin registry is code-side).
    pluginId: text('plugin_id'),
    // Markdown rule text. Concatenated into the Behavioral prompt layer.
    content: text('content').notNull(),
    source: customRuleSourceEnum('source').notNull().default('user_set'),
    // FK to the source dream when source='dreams_proposed'. Soft reference
    // (no FK constraint yet) — the `dreams` table doesn't exist until D1
    // ships in Track E. When D1 lands, the FK is added in the rename
    // migration. NULL for source='user_set'.
    dreamId: uuid('dream_id'),
    // Disable-without-delete. Set false to retire a rule while keeping the
    // historical record + any FK references (dream_id, etc.).
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Primary lookup pattern: pull all active rules for a user, by scope.
    userScopeActiveIdx: index('user_custom_rules_user_scope_active_idx')
      .on(t.userId, t.scope, t.isActive),
    // Agent-scope rules: bind to the agent id for the call's agent.
    userAgentActiveIdx: index('user_custom_rules_user_agent_active_idx')
      .on(t.userId, t.agentId, t.isActive)
      .where(sql`scope = 'agent' AND is_active = true`),
    // Page-scope rules: join with Flash candidates by wiki_page_id.
    pageActiveIdx: index('user_custom_rules_page_active_idx')
      .on(t.wikiPageId, t.isActive)
      .where(sql`scope = 'page' AND is_active = true`),
  }),
);

// Typed knob value overrides per (user, agent). Each row carries a JSONB
// blob keyed by knob_name → value. Defaults live in the plugin-registry
// KnobSpec; this table only stores user overrides. Read pattern: fetch
// row by (user_id, agent_id), merge over KnobSpec defaults.
//
// Compact-object shape (one row per user-agent) over per-knob rows for
// simplicity at v0.4.0 scale. Migrate to per-knob rows when audit /
// per-knob-disable / per-knob-history requirements emerge.
export const userAgentSettings = pgTable(
  'user_agent_settings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // Object keyed knob_name → value. Empty object {} = no overrides (all
    // knobs at their KnobSpec defaults). Schema-light by design — knob
    // shape evolves in the plugin registry, not in DDL.
    overrides: jsonb('overrides').notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.agentId] }),
  }),
);
