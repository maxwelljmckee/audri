// Manual todo creation. Server handles INSERT to wiki_pages + todos sidecar
// because RLS gates client-side INSERT (clients can SELECT/UPDATE their
// own todos sidecar rows but inserts go through this endpoint OR via
// ingestion fan-out).
//
// v0.2.1: status buckets dropped from wiki hierarchy. New todos land as
// direct children of the `todos` root with a sidecar row carrying
// status='todo' and parent_page_id=NULL by default. Caller can pass
// `parent_page_id` to associate the todo with another wiki page (project,
// goal, person, etc.) at creation time.

import { and, db, eq, isNull, todos, wikiPages, wikiSections } from '@audri/shared/db';
import { BadRequestException, Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { CurrentUser } from '../auth/user.decorator.js';

interface CreateTodoBody {
  title: string;
  content?: string;
  // Optional wiki page UUID to associate this todo with. NULL → "General"
  // swimlane in the Todos plugin UX.
  parent_page_id?: string | null;
}

@Controller('todos')
@UseGuards(SupabaseAuthGuard)
export class TodosController {
  private readonly logger = new Logger(TodosController.name);

  @Post()
  async create(@CurrentUser() user: { id: string }, @Body() body: CreateTodoBody) {
    const title = (body.title ?? '').trim();
    if (title.length === 0) throw new BadRequestException('title required');
    const content = (body.content ?? '').trim();
    const parentPageId =
      typeof body.parent_page_id === 'string' && body.parent_page_id.length > 0
        ? body.parent_page_id
        : null;

    return db.transaction(async (tx) => {
      // Resolve the user's `todos` root. All individual todos nest directly
      // under it (flat hierarchy now that status lives on the sidecar).
      const [todosRoot] = await tx
        .select({ id: wikiPages.id })
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.userId, user.id),
            eq(wikiPages.scope, 'user'),
            eq(wikiPages.slug, 'todos'),
            isNull(wikiPages.tombstonedAt),
          ),
        )
        .limit(1);
      if (!todosRoot) {
        throw new BadRequestException('todos root missing — user not seeded');
      }

      // Slug suffix uses ms + random tail for collision-free identity.
      const slug = `todos/${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const [todoRow] = await tx
        .insert(wikiPages)
        .values({
          userId: user.id,
          scope: 'user',
          type: 'todo',
          slug,
          parentPageId: todosRoot.id,
          title,
          agentAbstract: title,
        })
        .returning({ id: wikiPages.id });
      if (!todoRow) throw new Error('failed to create todo');

      if (content.length > 0) {
        await tx.insert(wikiSections).values({
          pageId: todoRow.id,
          title: null,
          content,
          sortOrder: 0,
        });
      }

      // Sidecar row — owns status + association.
      await tx.insert(todos).values({
        userId: user.id,
        pageId: todoRow.id,
        parentPageId,
        status: 'todo',
      });

      this.logger.log(
        { userId: user.id, pageId: todoRow.id, parentPageId },
        'todo created (wiki + sidecar)',
      );
      return { pageId: todoRow.id };
    });
  }
}
