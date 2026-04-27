import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
  enabledPlugins: text('enabled_plugins')
    .array()
    .notNull()
    .default(sql`ARRAY['research']::text[]`),
  onboardingComplete: boolean('onboarding_complete').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
