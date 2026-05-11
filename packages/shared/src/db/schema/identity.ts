import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './_auth.js';

// `root_page_id` references wiki_pages but the FK is added in the hand-edited
// migration as DEFERRABLE INITIALLY DEFERRED to break the circular FK
// (wiki_pages.agent_id → agents.id and agents.root_page_id → wiki_pages.id).
// Drizzle declares the column as a plain uuid here.
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    voice: text('voice').notNull(),
    personaPrompt: text('persona_prompt').notNull(),
    userPromptNotes: text('user_prompt_notes'),
    rootPageId: uuid('root_page_id'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
  },
  (t) => ({
    userSlugUnique: uniqueIndex('agents_user_slug_idx').on(t.userId, t.slug),
    userDefaultIdx: index('agents_user_default_idx').on(t.userId, t.isDefault),
  }),
);

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  enabledPlugins: text('enabled_plugins').array().notNull().default(sql`ARRAY['research']::text[]`),
  onboardingComplete: boolean('onboarding_complete').notNull().default(false),
  // IANA timezone name (e.g. 'America/Denver', 'Europe/London'). NULL
  // falls back to UTC. Used by the Usage aggregation endpoint to bucket
  // daily spend in the user's local time, by future scheduled-task
  // surfaces (daily briefs, dreaming cadence) to fire at user-local hours,
  // and by call-side preload for relative-time renderings. Added v0.2.1.
  // Mobile client populates from `Intl.DateTimeFormat().resolvedOptions().timeZone`
  // on first launch; user can edit later from Account → Preferences (V1+).
  timezone: text('timezone'),
  // Monthly spend cap in cents (NUMERIC for precision). NULL = no cap
  // (the default). Soft-only at v0.2.1 — surfaced as a progress bar +
  // warning banner on the Usage screen, but does NOT gate inference. Hard
  // enforcement is deferred to v0.2.2 or its own slice.
  monthlySpendLimitCents: numeric('monthly_spend_limit_cents', { precision: 12, scale: 2 }),
  // Fraction of the limit at which the warning banner fires (0..1].
  // Default 0.8 = 80%. Only meaningful when monthlySpendLimitCents is set.
  monthlySpendWarningThreshold: real('monthly_spend_warning_threshold').notNull().default(0.8),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // Account tombstone. Set by DELETE /me. Auth guard rejects authenticated
  // requests when this is non-null. Data stays intact; hard-delete + export
  // are V1+.
  tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
});
