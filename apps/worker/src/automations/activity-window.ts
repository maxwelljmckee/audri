// Activity-window snapshot — shared input for all synthesis-style
// automation handlers (recap, brief_me, stalled_work, eventually
// dreaming's Light phase). Single helper that fetches the user's
// recent activity across plugins for a given [windowStart, windowEnd]
// range.
//
// Each handler picks the slices it cares about + composes its own
// prompt. The slices arrive pre-joined + lightly normalized so the
// handler doesn't re-join in TS land.
//
// Implementation: parallel SQL queries (one per slice). Drizzle's
// transaction isn't needed — these are pure reads. Slices that the
// caller didn't request via `include` are skipped to bound DB work.

import {
  agentTasks,
  and,
  callTranscripts,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  researchOutputs,
  sql,
  todos,
  wikiPages,
  wikiSectionHistory,
  wikiSections,
} from '@audri/shared/db';

export interface CallExcerpt {
  transcriptId: string;
  sessionId: string;
  startedAt: string;
  durationSeconds: number | null;
  title: string | null;
  summary: string | null;
  callType: 'generic' | 'onboarding';
  // First N user turns of the call (truncated). Gives the synthesis
  // prompt enough content to reason about without sending full
  // transcripts (which would blow Pro's context budget at scale).
  userTurnExcerpts: string[];
}

export interface NoteEdit {
  pageSlug: string;
  pageTitle: string;
  sectionTitle: string | null;
  contentExcerpt: string;
  editedBy: 'ai' | 'user' | 'lint' | 'task';
  editedAt: string;
}

export interface TodoCompleted {
  title: string;
  completedAt: string;
  parentPageSlug: string | null;
}

export interface TodoActive {
  title: string;
  dueAt: string | null;
  createdAt: string;
  status: 'todo' | 'in-progress';
  daysOpen: number;
  parentPageSlug: string | null;
}

export interface TodoOverdue {
  title: string;
  dueAt: string;
  overdueDays: number;
}

export interface ResearchCompleted {
  title: string;
  query: string;
  completedAt: string;
}

export interface ResearchPending {
  query: string;
  spawnedAt: string;
}

export interface ReminderDue {
  title: string;
  dueAt: string;
}

export interface DreamEntry {
  title: string;
  agentName: string;
  createdAt: string;
  reviewed: boolean;
}

export interface ActivityWindow {
  windowStart: string;
  windowEnd: string;
  userTimezone: string;
  calls: CallExcerpt[];
  notesActivity: NoteEdit[];
  todos: {
    completedInWindow: TodoCompleted[];
    activeNow: TodoActive[];
    overdueNow: TodoOverdue[];
  };
  research: {
    completedInWindow: ResearchCompleted[];
    pendingNow: ResearchPending[];
  };
  remindersDueInWindow: ReminderDue[];
  dreams: DreamEntry[];
}

export interface ActivityWindowInclude {
  calls?: boolean;
  notesActivity?: boolean;
  todos?: boolean;
  research?: boolean;
  reminders?: boolean;
  dreams?: boolean;
}

export interface FetchActivityWindowOpts {
  userId: string;
  windowStart: Date;
  windowEnd: Date;
  timezone: string;
  include?: ActivityWindowInclude;
}

// Max items per slice. Bounds prompt-token cost when a user's window is
// dense. Synthesis handlers should reason about *signal*, not enumerate
// every row.
const MAX_CALLS = 12;
const MAX_NOTES_EDITS = 24;
const MAX_TODOS_COMPLETED = 30;
const MAX_TODOS_ACTIVE = 40;
const MAX_TODOS_OVERDUE = 20;
const MAX_RESEARCH = 12;
const MAX_REMINDERS = 20;
const MAX_DREAMS = 12;

const USER_TURNS_PER_CALL = 6;
const NOTE_EXCERPT_CHARS = 250;

export async function fetchActivityWindow(
  opts: FetchActivityWindowOpts,
): Promise<ActivityWindow> {
  const inc = opts.include ?? {
    calls: true,
    notesActivity: true,
    todos: true,
    research: true,
    reminders: true,
    dreams: true,
  };

  const [calls, notesActivity, todosBucket, researchBucket, reminders, dreams] =
    await Promise.all([
      inc.calls ? fetchCalls(opts) : Promise.resolve([] as CallExcerpt[]),
      inc.notesActivity ? fetchNotesActivity(opts) : Promise.resolve([] as NoteEdit[]),
      inc.todos ? fetchTodos(opts) : Promise.resolve(emptyTodosBucket()),
      inc.research ? fetchResearch(opts) : Promise.resolve(emptyResearchBucket()),
      inc.reminders ? fetchRemindersDueInWindow(opts) : Promise.resolve([] as ReminderDue[]),
      inc.dreams ? fetchDreams(opts) : Promise.resolve([] as DreamEntry[]),
    ]);

  return {
    windowStart: opts.windowStart.toISOString(),
    windowEnd: opts.windowEnd.toISOString(),
    userTimezone: opts.timezone,
    calls,
    notesActivity,
    todos: todosBucket,
    research: researchBucket,
    remindersDueInWindow: reminders,
    dreams,
  };
}

async function fetchCalls(opts: FetchActivityWindowOpts): Promise<CallExcerpt[]> {
  const rows = await db
    .select({
      id: callTranscripts.id,
      sessionId: callTranscripts.sessionId,
      startedAt: callTranscripts.startedAt,
      durationSeconds: callTranscripts.durationSeconds,
      title: callTranscripts.title,
      summary: callTranscripts.summary,
      callType: callTranscripts.callType,
      content: callTranscripts.content,
    })
    .from(callTranscripts)
    .where(
      and(
        eq(callTranscripts.userId, opts.userId),
        gte(callTranscripts.startedAt, opts.windowStart),
        lte(callTranscripts.startedAt, opts.windowEnd),
        eq(callTranscripts.cancelled, false),
      ),
    )
    .orderBy(desc(callTranscripts.startedAt))
    .limit(MAX_CALLS);

  return rows.map((r) => ({
    transcriptId: r.id,
    sessionId: r.sessionId,
    startedAt: r.startedAt.toISOString(),
    durationSeconds: r.durationSeconds,
    title: r.title,
    summary: r.summary,
    callType: r.callType,
    userTurnExcerpts: extractUserTurns(r.content, USER_TURNS_PER_CALL),
  }));
}

function extractUserTurns(content: unknown, max: number): string[] {
  if (!Array.isArray(content)) return [];
  const userTurns: string[] = [];
  for (const turn of content) {
    if (
      turn &&
      typeof turn === 'object' &&
      (turn as { role?: unknown }).role === 'user' &&
      typeof (turn as { text?: unknown }).text === 'string'
    ) {
      userTurns.push((turn as { text: string }).text);
      if (userTurns.length >= max) break;
    }
  }
  return userTurns;
}

async function fetchNotesActivity(opts: FetchActivityWindowOpts): Promise<NoteEdit[]> {
  // Use wiki_section_history as the source of truth — it has the editor +
  // edit timestamp + content snapshot. Join up to wiki_sections + wiki_pages
  // for context.
  const rows = await db
    .select({
      sectionId: wikiSectionHistory.sectionId,
      content: wikiSectionHistory.content,
      editedBy: wikiSectionHistory.editedBy,
      editedAt: wikiSectionHistory.editedAt,
      sectionTitle: wikiSections.title,
      pageId: wikiSections.pageId,
      pageSlug: wikiPages.slug,
      pageTitle: wikiPages.title,
    })
    .from(wikiSectionHistory)
    .innerJoin(wikiSections, eq(wikiSections.id, wikiSectionHistory.sectionId))
    .innerJoin(wikiPages, eq(wikiPages.id, wikiSections.pageId))
    .where(
      and(
        eq(wikiPages.userId, opts.userId),
        eq(wikiPages.scope, 'user'),
        isNull(wikiPages.tombstonedAt),
        isNull(wikiPages.archivedAt),
        isNull(wikiSections.tombstonedAt),
        gte(wikiSectionHistory.editedAt, opts.windowStart),
        lte(wikiSectionHistory.editedAt, opts.windowEnd),
      ),
    )
    .orderBy(desc(wikiSectionHistory.editedAt))
    .limit(MAX_NOTES_EDITS);

  return rows.map((r) => ({
    pageSlug: r.pageSlug,
    pageTitle: r.pageTitle,
    sectionTitle: r.sectionTitle,
    contentExcerpt: truncate(r.content, NOTE_EXCERPT_CHARS),
    editedBy: r.editedBy,
    editedAt: r.editedAt.toISOString(),
  }));
}

interface TodosBucket {
  completedInWindow: TodoCompleted[];
  activeNow: TodoActive[];
  overdueNow: TodoOverdue[];
}

function emptyTodosBucket(): TodosBucket {
  return { completedInWindow: [], activeNow: [], overdueNow: [] };
}

async function fetchTodos(opts: FetchActivityWindowOpts): Promise<TodosBucket> {
  const [completed, active, overdue] = await Promise.all([
    fetchCompletedTodos(opts),
    fetchActiveTodos(opts),
    fetchOverdueTodos(opts),
  ]);
  return { completedInWindow: completed, activeNow: active, overdueNow: overdue };
}

async function fetchCompletedTodos(opts: FetchActivityWindowOpts): Promise<TodoCompleted[]> {
  // Todos table has status + completedAt; join wiki_pages for title + parent.
  const rows = await db
    .select({
      title: wikiPages.title,
      completedAt: todos.completedAt,
      parentPageId: todos.parentPageId,
    })
    .from(todos)
    .innerJoin(wikiPages, eq(wikiPages.id, todos.pageId))
    .where(
      and(
        eq(todos.userId, opts.userId),
        eq(todos.status, 'done'),
        isNotNull(todos.completedAt),
        gte(todos.completedAt, opts.windowStart),
        lte(todos.completedAt, opts.windowEnd),
        isNull(wikiPages.tombstonedAt),
      ),
    )
    .orderBy(desc(todos.completedAt))
    .limit(MAX_TODOS_COMPLETED);

  // Resolve parent slug if any. Cheap second-pass lookup; could be a
  // single JOIN but Drizzle's self-join ergonomics make this clearer.
  const parentIds = rows
    .map((r) => r.parentPageId)
    .filter((p): p is string => !!p);
  const parentSlugs = await resolveParentSlugs(parentIds);

  return rows.map((r) => ({
    title: r.title,
    completedAt: r.completedAt?.toISOString() ?? '',
    parentPageSlug: r.parentPageId ? parentSlugs.get(r.parentPageId) ?? null : null,
  }));
}

async function fetchActiveTodos(opts: FetchActivityWindowOpts): Promise<TodoActive[]> {
  const nowMs = opts.windowEnd.getTime();
  const rows = await db
    .select({
      title: wikiPages.title,
      dueAt: todos.dueDate,
      createdAt: todos.createdAt,
      status: todos.status,
      parentPageId: todos.parentPageId,
    })
    .from(todos)
    .innerJoin(wikiPages, eq(wikiPages.id, todos.pageId))
    .where(
      and(
        eq(todos.userId, opts.userId),
        inArray(todos.status, ['todo', 'in-progress']),
        isNull(wikiPages.tombstonedAt),
      ),
    )
    .orderBy(desc(todos.createdAt))
    .limit(MAX_TODOS_ACTIVE);

  const parentIds = rows.map((r) => r.parentPageId).filter((p): p is string => !!p);
  const parentSlugs = await resolveParentSlugs(parentIds);

  return rows.map((r) => ({
    title: r.title,
    dueAt: r.dueAt ? r.dueAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    status: r.status === 'in-progress' ? 'in-progress' : 'todo',
    daysOpen: Math.floor((nowMs - r.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
    parentPageSlug: r.parentPageId ? parentSlugs.get(r.parentPageId) ?? null : null,
  }));
}

async function fetchOverdueTodos(opts: FetchActivityWindowOpts): Promise<TodoOverdue[]> {
  const nowMs = opts.windowEnd.getTime();
  const rows = await db
    .select({
      title: wikiPages.title,
      dueAt: todos.dueDate,
    })
    .from(todos)
    .innerJoin(wikiPages, eq(wikiPages.id, todos.pageId))
    .where(
      and(
        eq(todos.userId, opts.userId),
        inArray(todos.status, ['todo', 'in-progress']),
        isNotNull(todos.dueDate),
        lte(todos.dueDate, opts.windowEnd),
        isNull(wikiPages.tombstonedAt),
      ),
    )
    .orderBy(desc(todos.dueDate))
    .limit(MAX_TODOS_OVERDUE);

  return rows
    .filter((r): r is { title: string; dueAt: Date } => r.dueAt !== null)
    .map((r) => ({
      title: r.title,
      dueAt: r.dueAt.toISOString(),
      overdueDays: Math.floor((nowMs - r.dueAt.getTime()) / (1000 * 60 * 60 * 24)),
    }));
}

interface ResearchBucket {
  completedInWindow: ResearchCompleted[];
  pendingNow: ResearchPending[];
}

function emptyResearchBucket(): ResearchBucket {
  return { completedInWindow: [], pendingNow: [] };
}

async function fetchResearch(opts: FetchActivityWindowOpts): Promise<ResearchBucket> {
  const [completed, pending] = await Promise.all([
    db
      .select({
        title: researchOutputs.title,
        query: researchOutputs.query,
        completedAt: researchOutputs.generatedAt,
      })
      .from(researchOutputs)
      .where(
        and(
          eq(researchOutputs.userId, opts.userId),
          gte(researchOutputs.generatedAt, opts.windowStart),
          lte(researchOutputs.generatedAt, opts.windowEnd),
          isNull(researchOutputs.tombstonedAt),
        ),
      )
      .orderBy(desc(researchOutputs.generatedAt))
      .limit(MAX_RESEARCH),
    db
      .select({
        query: sql<string>`${agentTasks.payload}->>'query'`,
        spawnedAt: agentTasks.createdAt,
      })
      .from(agentTasks)
      .where(
        and(
          eq(agentTasks.userId, opts.userId),
          eq(agentTasks.kind, 'research'),
          inArray(agentTasks.status, ['pending', 'running']),
        ),
      )
      .orderBy(desc(agentTasks.createdAt))
      .limit(MAX_RESEARCH),
  ]);

  return {
    completedInWindow: completed.map((r) => ({
      title: r.title,
      query: r.query,
      completedAt: r.completedAt?.toISOString() ?? '',
    })),
    pendingNow: pending
      .filter((r): r is { query: string; spawnedAt: Date } => !!r.query)
      .map((r) => ({ query: r.query, spawnedAt: r.spawnedAt.toISOString() })),
  };
}

async function fetchRemindersDueInWindow(
  opts: FetchActivityWindowOpts,
): Promise<ReminderDue[]> {
  // Reminders are recurring_agent_tasks rows with kind='todo_reminder';
  // each fire spawns a todo with a due_date matching the reminder's
  // schedule. For "what's due in the window", we look at the spawned
  // todos with due_date in the range — same as the todo path, just
  // narrowed to reminder-derived todos. For v0.3.0 simplicity, return
  // todos with non-null due_date in window that the user might want to
  // see surfaced — handler decides what to filter further.
  const rows = await db
    .select({
      title: wikiPages.title,
      dueAt: todos.dueDate,
    })
    .from(todos)
    .innerJoin(wikiPages, eq(wikiPages.id, todos.pageId))
    .where(
      and(
        eq(todos.userId, opts.userId),
        inArray(todos.status, ['todo', 'in-progress']),
        isNotNull(todos.dueDate),
        gte(todos.dueDate, opts.windowStart),
        lte(todos.dueDate, opts.windowEnd),
        isNull(wikiPages.tombstonedAt),
      ),
    )
    .orderBy(desc(todos.dueDate))
    .limit(MAX_REMINDERS);

  return rows
    .filter((r): r is { title: string; dueAt: Date } => r.dueAt !== null)
    .map((r) => ({ title: r.title, dueAt: r.dueAt.toISOString() }));
}

async function fetchDreams(_opts: FetchActivityWindowOpts): Promise<DreamEntry[]> {
  // Dreams are wiki_pages with type='dream'. That enum value isn't
  // added yet — it lands with the dreaming handler (#25) alongside
  // the migration that extends pageTypeEnum. Until then, returning
  // [] keeps the slice present in the shape so recap / brief
  // consumers don't have to special-case. Re-enable the query when
  // 'dream' is added to page_type.
  return [];
}

async function resolveParentSlugs(pageIds: string[]): Promise<Map<string, string>> {
  if (pageIds.length === 0) return new Map();
  const rows = await db
    .select({ id: wikiPages.id, slug: wikiPages.slug })
    .from(wikiPages)
    .where(inArray(wikiPages.id, pageIds));
  return new Map(rows.map((r) => [r.id, r.slug]));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}
