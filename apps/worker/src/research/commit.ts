// Research output commit — single transaction. Writes the artifact +
// citations + ancestor sources, marks the agent_task succeeded, reparents
// the originating todo wiki page → todos/done, emits usage_event + wiki_log.
//
// Per specs/research-task-prompt.md "Backend's commit helper writes" section.

import {
  agentTasks,
  and,
  db,
  eq,
  isNull,
  researchOutputSources,
  researchOutputs,
  usageEvents,
  wikiLog,
  wikiPages,
} from '@audri/shared/db';
import type { ResearchHandlerResult } from './handler.js';

interface CommitArgs {
  userId: string;
  agentTaskId: string;
  todoPageId: string;
  result: ResearchHandlerResult;
}

export interface CommitResult {
  researchOutputId: string;
}

export async function commitResearchOutput(args: CommitArgs): Promise<CommitResult> {
  const { userId, agentTaskId, todoPageId, result } = args;
  const { output, modelUsed, tokensIn, tokensOut } = result;

  return db.transaction(async (tx) => {
    // 1. Insert research_outputs row.
    const [row] = await tx
      .insert(researchOutputs)
      .values({
        userId,
        agentTasksId: agentTaskId,
        query: output.query,
        summary: output.summary,
        findings: output.findings,
        citations: output.citations,
        followUpQuestions: output.follow_up_questions ?? [],
        notesForUser: output.notes_for_user ?? null,
        modelUsed,
        tokensIn,
        tokensOut,
      })
      .returning({ id: researchOutputs.id });
    if (!row) throw new Error('research_outputs insert returned no row');
    const researchOutputId = row.id;

    // 2. Insert per-citation source rows.
    if (output.citations.length > 0) {
      await tx.insert(researchOutputSources).values(
        output.citations.map((c, idx) => ({
          researchOutputId,
          url: c.url,
          title: c.title || null,
          snippet: c.snippet,
          citationIndex: idx + 1, // 1-indexed per spec
        })),
      );
    }

    // 3. Mark agent_task succeeded.
    await tx
      .update(agentTasks)
      .set({
        status: 'succeeded',
        completedAt: new Date(),
        updatedAt: new Date(),
        resultArtifactKind: 'research',
        resultArtifactId: researchOutputId,
      })
      .where(eq(agentTasks.id, agentTaskId));

    // 4. Reparent the originating todo page → todos/done.
    const [doneBucket] = await tx
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.userId, userId),
          eq(wikiPages.scope, 'user'),
          eq(wikiPages.slug, 'todos/done'),
          isNull(wikiPages.tombstonedAt),
        ),
      )
      .limit(1);
    if (doneBucket) {
      await tx
        .update(wikiPages)
        .set({ parentPageId: doneBucket.id, updatedAt: new Date() })
        .where(eq(wikiPages.id, todoPageId));
    }

    // 5. Usage event.
    await tx.insert(usageEvents).values({
      userId,
      agentTasksId: agentTaskId,
      eventKind: 'plugin_research',
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      model: modelUsed,
      artifactKind: 'research',
      artifactId: researchOutputId,
    });

    // 6. wiki_log breadcrumb.
    await tx.insert(wikiLog).values({
      userId,
      kind: 'task',
      summary: `research complete: ${output.query.slice(0, 120)}`,
      ref: { researchOutputId, agentTaskId, kind: 'research' },
    });

    return { researchOutputId };
  });
}
