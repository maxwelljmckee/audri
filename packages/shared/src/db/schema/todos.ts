// Todos sidecar — first-class typed surface backing the Todos plugin UX.
//
// v0.2.1 architecture change (2026-05-10): todos are no longer a flat
// status-bucket hierarchy on `wiki_pages`. The wiki layer stays as a
// translation/triggering shell — every todo wiki row has exactly one
// sidecar row joined on `page_id`, and the sidecar owns lifecycle:
//
//   - `status`: 'todo' | 'in-progress' | 'done' | 'archived' (column,
//     not parent_page_id hierarchy as before)
//   - `parent_page_id`: nullable FK to `wiki_pages` — generalizes
//     "project-scoped" to "associated-with-any-wiki-page". A project todo
//     points at the project; a goal todo points at `profile/goals`; a
//     person-related todo can point at the person's wiki page; uncategorized
//     todos have NULL.
//   - `due_date` / `completed_at`: lifecycle timestamps
//
// The Todos plugin UX renders vertical swimlanes grouped by `parent_page_id`
// (resolved to the wiki page title), with a "General" section for NULL.
// Sections collapsible.
//
// Wiki-side `wiki_pages.type='todo'` rows still exist — they're the shell
// that ingestion / fan-out / agent-tasks dispatch all reference. They're
// hidden from the Notes UI (per single-source-of-truth rule, 2026-05-10)
// and live as direct children of the `todos` root page (flat — no status
// bucket sub-pages).

import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authUsers } from './_auth.js';
import { todoStatusEnum } from './enums.js';
import { agents } from './identity.js';
import { wikiPages } from './wiki.js';

export const todos = pgTable(
  'todos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    // 1:1 with the wiki shell. Cascade so deleting the wiki page wipes the
    // sidecar; UNIQUE ensures we never get two sidecars for the same page.
    pageId: uuid('page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'cascade' }),
    // Generalized association — points at any user-scope wiki page (project,
    // goal sub-page, person, concept, etc.). NULL = uncategorized / "General"
    // swimlane. Default ALWAYS null unless transcript explicitly directs an
    // association — see fan-out-prompt.md routing rules.
    parentPageId: uuid('parent_page_id').references(() => wikiPages.id, {
      onDelete: 'set null',
    }),
    // Who is on the hook. NULL = the user themselves owns the todo (default,
    // most common). Non-null FK to `agents` = a specific persona (Audri /
    // assistant today; V1+ Health Coach, Finance Coach, etc.) owes this back
    // to the user. Used by:
    //   - call-side preload composer to render "Open todos" grouped by owner
    //   - fan-out prompt to disambiguate "I'll send you X" (assistant) vs
    //     "I should send Alex X" (user)
    //   - Todos plugin UX (V1+: filter / badge by assignee)
    // ON DELETE SET NULL — if an agent gets deleted, todos fall back to user.
    assigneeAgentId: uuid('assignee_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    status: todoStatusEnum('status').notNull().default('todo'),
    dueDate: timestamp('due_date', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Bumped on every write — drives replication's lastModifiedField. App
    // code is responsible for setting it on update; Postgres won't auto-bump.
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // 1:1 with the wiki shell.
    pageUnique: uniqueIndex('todos_page_idx').on(t.pageId),
    // Primary read pattern: per-user, ORDER BY status / parent_page_id.
    userStatusIdx: index('todos_user_status_idx').on(t.userId, t.status),
    userParentIdx: index('todos_user_parent_idx').on(t.userId, t.parentPageId),
  }),
);
