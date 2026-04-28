// Manual todo creation. Server handles INSERT to wiki_pages because RLS
// gates client-side INSERT (clients can SELECT/UPDATE/DELETE their own
// user-scope pages, but creation is server-only — pages typically arrive
// via ingestion fan-out).

import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  and,
  db,
  eq,
  isNull,
  wikiPages,
  wikiSections,
} from '@audri/shared/db';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { CurrentUser } from '../auth/user.decorator.js';

interface CreateTodoBody {
  title: string;
  content?: string;
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

    return db.transaction(async (tx) => {
      const [bucket] = await tx
        .select({ id: wikiPages.id })
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.userId, user.id),
            eq(wikiPages.scope, 'user'),
            eq(wikiPages.slug, 'todos/todo'),
            isNull(wikiPages.tombstonedAt),
          ),
        )
        .limit(1);
      if (!bucket) {
        throw new BadRequestException('todos/todo bucket missing — user not seeded');
      }

      // Slug suffix uses ms + random tail for collision-free identity. Only
      // the bucket pages need stable slugs; user-created todos can have any
      // unique slug.
      const slug = `todos/todo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const [todoRow] = await tx
        .insert(wikiPages)
        .values({
          userId: user.id,
          scope: 'user',
          type: 'todo',
          slug,
          parentPageId: bucket.id,
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

      this.logger.log({ userId: user.id, pageId: todoRow.id }, 'todo created');
      return { pageId: todoRow.id };
    });
  }
}
