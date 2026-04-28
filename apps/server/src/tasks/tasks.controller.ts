// Endpoints for explicitly spawning agent_tasks (e.g. from the Research
// overlay's "research this" affordance). Bypasses ingestion — these are user-
// initiated, not extracted from a transcript.
//
// Per todos.md §11. Currently only `research` is exposed.

import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  agentTasks,
  and,
  db,
  eq,
  isNull,
  sql,
  wikiPages,
} from '@audri/shared/db';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { CurrentUser } from '../auth/user.decorator.js';

interface SpawnResearchBody {
  query: string;
  context_summary?: string;
}

@Controller('tasks')
@UseGuards(SupabaseAuthGuard)
export class TasksController {
  private readonly logger = new Logger(TasksController.name);

  @Post('research')
  async spawnResearch(
    @CurrentUser() user: { id: string },
    @Body() body: SpawnResearchBody,
  ) {
    const query = (body.query ?? '').trim();
    if (query.length === 0) throw new BadRequestException('query required');

    return db.transaction(async (tx) => {
      // Find the user's todos/todo bucket as parent for the originating todo
      // page. Seed runs on signup so this should always exist.
      const [todoBucket] = await tx
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
      if (!todoBucket) {
        throw new BadRequestException('todos/todo bucket missing — user not seeded');
      }

      // Create the todo wiki page tracking this research request.
      const todoTitle = `Research: ${query.slice(0, 100)}`;
      const [todoRow] = await tx
        .insert(wikiPages)
        .values({
          userId: user.id,
          scope: 'user',
          type: 'todo',
          slug: `todos/research-${Date.now()}`,
          parentPageId: todoBucket.id,
          title: todoTitle,
          agentAbstract: `Research request: ${query}`,
        })
        .returning({ id: wikiPages.id });
      if (!todoRow) throw new Error('failed to create todo page');

      // Create the agent_tasks row.
      const [taskRow] = await tx
        .insert(agentTasks)
        .values({
          userId: user.id,
          todoPageId: todoRow.id,
          kind: 'research',
          payload: { query, ...(body.context_summary ? { context_summary: body.context_summary } : {}) },
          status: 'pending',
        })
        .returning({ id: agentTasks.id });
      if (!taskRow) throw new Error('failed to create agent_task');

      // Enqueue Graphile job — same transaction so the job can't fire before
      // the row is committed.
      const dispatchPayload = JSON.stringify({ agentTaskId: taskRow.id });
      await tx.execute(sql`
        SELECT graphile_worker.add_job(
          'agent_task_dispatch',
          ${dispatchPayload}::json,
          max_attempts => 2
        )
      `);

      this.logger.log(
        { userId: user.id, agentTaskId: taskRow.id, query },
        'research task spawned',
      );

      return { agentTaskId: taskRow.id, todoPageId: todoRow.id };
    });
  }
}
