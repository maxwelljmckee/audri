// Generic-call context preload. Reads the user's profile + agent-scope notes
// + recently-touched wiki pages, and renders them as a "What I know about
// you" block injected into the system prompt.
//
// Onboarding writes profile content; without this, generic calls open without
// any of that grounding and feel cold-start. This is the payoff for slice 6.
//
// Token budget is informal — we cap aggressively per-section so a verbose
// profile doesn't blow the context window. "Recent topics" surfaces via
// recently-updated wiki pages — those are richer than call summaries since
// they reflect what was actually extracted and considered worth remembering.

import {
  aliasedTable,
  and,
  db,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from '@audri/shared/db';
import {
  agentOpenItems,
  agents,
  callTranscripts,
  todos,
  wikiPages,
  wikiSections,
} from '@audri/shared/db';

const RECENT_PAGES_LIMIT = 8;
const MAX_SECTION_CHARS = 1200;
const INCOMPLETE_CALL_LOOKBACK_HOURS = 24;
// Cap on depth-2 children per top-level page in the structural snapshot.
// Keeps token budget bounded as the user's wiki grows; deeper exploration
// happens via Flash candidate retrieval at ingestion time, not at call start.
const STRUCTURE_CHILDREN_PER_PARENT_LIMIT = 12;
// Per-call cap on agent_open_items injected into the prompt. Composer reads
// top-K pending for this persona, ranked by priority then recency. Saturation
// guard — bumped/tuned once we have field signal on delivery feel. Stage 2
// (manual seed) keeps the list short on purpose.
const OPEN_ITEMS_PER_CALL_LIMIT = 5;

interface PageWithSections {
  slug: string;
  title: string;
  agentAbstract: string;
  abstract: string | null;
  sections: Array<{ title: string | null; content: string }>;
}

interface RecentPage {
  slug: string;
  title: string;
  scope: 'user' | 'agent';
  updatedAt: Date;
  agentAbstract: string;
}

interface IncompleteCall {
  endedAt: Date;
  endReason: string;
  // Slugs of pages that ingestion touched on this transcript — useful for
  // the agent to say "we were talking about X." Empty if nothing was
  // extracted (the call ended before substantive content).
  touchedSlugs: string[];
}

// One row from agent_open_items, ranked + capped for prompt injection.
// `kind` drives delivery framing (curiosity vs. proactive enrichment); see
// renderOpenItems for prompt-side guidance.
interface OpenItem {
  id: string;
  kind: 'question' | 'info_share';
  topic: string;
  bodyText: string;
  priority: number;
  createdAt: Date;
}

// One in-flight todo (status='todo' or 'in-progress'), joined with its
// wiki page for the title + with its parent_page_id resolved to a slug/title
// for the grouping. Assignee resolves to the agent slug if non-NULL, else
// implicitly 'user'. Rendered in the preload as `## Open todos`.
interface InflightTodo {
  pageId: string;
  title: string;
  status: 'todo' | 'in-progress';
  parentTitle: string | null;
  // Resolved persona slug; NULL means user-assigned (the default).
  assigneeAgentSlug: string | null;
  dueDate: Date | null;
}

// Structural snapshot of the wiki — top-level pages + their immediate children
// (depth 2). Powers the Live Agent's ability to reason about "where does this
// new thing fit" — see specs/conversational-routing.md (Autonomy principle
// extended to structural ambiguity) and the system-prompt's wiki-structure
// section. Distinct from `recentPages` which surfaces *active* areas; this
// surfaces *shape*.
interface WikiStructureNode {
  slug: string;
  title: string;
  type: string;
  agentAbstract: string;
  children: Array<{ slug: string; title: string; type: string; agentAbstract: string }>;
  childrenTruncated: boolean;
}

interface PreloadData {
  profile: PageWithSections[];
  agentNotes: PageWithSections[];
  recentPages: RecentPage[];
  wikiStructure: WikiStructureNode[];
  incompleteCall: IncompleteCall | null;
  openItems: OpenItem[];
  inflightTodos: InflightTodo[];
}

export async function loadGenericCallContext(
  userId: string,
  agentId: string,
): Promise<PreloadData> {
  const [
    profile,
    agentNotes,
    recentPages,
    wikiStructure,
    incompleteCall,
    openItems,
    inflightTodos,
  ] = await Promise.all([
    fetchPagesByPrefix(userId, 'user', 'profile'),
    fetchPagesByPrefix(userId, 'agent', 'assistant'),
    fetchRecentPages(userId),
    fetchWikiStructure(userId),
    fetchMostRecentIncompleteCall(userId),
    fetchPendingOpenItems(userId, agentId),
    fetchInflightTodos(userId),
  ]);

  return {
    profile,
    agentNotes,
    recentPages,
    wikiStructure,
    incompleteCall,
    openItems,
    inflightTodos,
  };
}

async function fetchPagesByPrefix(
  userId: string,
  scope: 'user' | 'agent',
  rootSlug: string,
): Promise<PageWithSections[]> {
  // Match either the root page or any descendant by slug-prefix. Slug
  // hierarchy is path-like (e.g. `profile/goals`).
  const rows = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      agentAbstract: wikiPages.agentAbstract,
      abstract: wikiPages.abstract,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.userId, userId),
        eq(wikiPages.scope, scope),
        isNull(wikiPages.tombstonedAt),
        sql`(${wikiPages.slug} = ${rootSlug} OR ${wikiPages.slug} LIKE ${`${rootSlug}/%`})`,
      ),
    );

  if (rows.length === 0) return [];

  const slugs = rows.map((r) => r.slug);
  const sectionRows = await db
    .select({
      pageSlug: wikiPages.slug,
      title: wikiSections.title,
      content: wikiSections.content,
      sortOrder: wikiSections.sortOrder,
    })
    .from(wikiSections)
    .innerJoin(wikiPages, eq(wikiPages.id, wikiSections.pageId))
    .where(
      and(
        eq(wikiPages.userId, userId),
        eq(wikiPages.scope, scope),
        isNull(wikiSections.tombstonedAt),
        // inArray builds `slug IN ($1, $2, …)` with proper parameter binding.
        // The previous `sql\`${slug} = ANY(${slugs})\`` form bound the JS
        // array as a single text parameter; postgres-js then complained
        // "op ANY/ALL (array) requires array on right side" — Drizzle
        // doesn't auto-spread arrays inside the sql template tag.
        inArray(wikiPages.slug, slugs),
      ),
    )
    .orderBy(wikiSections.sortOrder);

  const sectionsBySlug = new Map<string, Array<{ title: string | null; content: string }>>();
  for (const s of sectionRows) {
    const list = sectionsBySlug.get(s.pageSlug) ?? [];
    list.push({ title: s.title, content: truncate(s.content, MAX_SECTION_CHARS) });
    sectionsBySlug.set(s.pageSlug, list);
  }

  // Skip empty pages — no point taking up tokens for a stub.
  return rows
    .map((r) => ({ ...r, sections: sectionsBySlug.get(r.slug) ?? [] }))
    .filter((p) => p.sections.length > 0 || p.abstract);
}

// Top-level (parent_page_id IS NULL) user-scope pages + their immediate
// children. Two queries: one for the top-level set, one for the child set
// keyed by parent id. Capped per-parent so wide categories (e.g. a
// many-projects user) don't blow the token budget.
async function fetchWikiStructure(userId: string): Promise<WikiStructureNode[]> {
  const tops = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      type: wikiPages.type,
      agentAbstract: wikiPages.agentAbstract,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.userId, userId),
        eq(wikiPages.scope, 'user'),
        isNull(wikiPages.tombstonedAt),
        isNull(wikiPages.parentPageId),
      ),
    )
    .orderBy(wikiPages.slug);

  if (tops.length === 0) return [];

  const topIds = tops.map((t) => t.id);
  const childRows = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      type: wikiPages.type,
      agentAbstract: wikiPages.agentAbstract,
      parentPageId: wikiPages.parentPageId,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.userId, userId),
        eq(wikiPages.scope, 'user'),
        isNull(wikiPages.tombstonedAt),
        isNotNull(wikiPages.parentPageId),
        inArray(wikiPages.parentPageId, topIds),
      ),
    )
    .orderBy(wikiPages.slug);

  const childrenByParent = new Map<
    string,
    Array<{ slug: string; title: string; type: string; agentAbstract: string }>
  >();
  for (const c of childRows) {
    if (!c.parentPageId) continue;
    const list = childrenByParent.get(c.parentPageId) ?? [];
    list.push({ slug: c.slug, title: c.title, type: c.type, agentAbstract: c.agentAbstract });
    childrenByParent.set(c.parentPageId, list);
  }

  return tops.map((t) => {
    const all = childrenByParent.get(t.id) ?? [];
    const truncated = all.length > STRUCTURE_CHILDREN_PER_PARENT_LIMIT;
    return {
      slug: t.slug,
      title: t.title,
      type: t.type,
      agentAbstract: t.agentAbstract,
      children: truncated ? all.slice(0, STRUCTURE_CHILDREN_PER_PARENT_LIMIT) : all,
      childrenTruncated: truncated,
    };
  });
}

async function fetchRecentPages(userId: string): Promise<RecentPage[]> {
  const rows = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      scope: wikiPages.scope,
      updatedAt: wikiPages.updatedAt,
      agentAbstract: wikiPages.agentAbstract,
    })
    .from(wikiPages)
    .where(and(eq(wikiPages.userId, userId), isNull(wikiPages.tombstonedAt)))
    .orderBy(desc(wikiPages.updatedAt))
    .limit(RECENT_PAGES_LIMIT);

  return rows as RecentPage[];
}

// Surface a dropped call ONLY when it is the user's most recent transcript.
// Any subsequent clean (`user_ended`) or user-cancelled call means the user
// has moved on, and the prior drop is no longer relevant — we'd rather stay
// silent than keep nagging about a stale drop. Lookback still applies so a
// dropped call from weeks ago doesn't resurface for a returning user.
async function fetchMostRecentIncompleteCall(userId: string): Promise<IncompleteCall | null> {
  const cutoff = new Date(Date.now() - INCOMPLETE_CALL_LOOKBACK_HOURS * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: callTranscripts.id,
      endedAt: callTranscripts.endedAt,
      endReason: callTranscripts.endReason,
      cancelled: callTranscripts.cancelled,
    })
    .from(callTranscripts)
    .where(
      and(
        eq(callTranscripts.userId, userId),
        sql`${callTranscripts.endedAt} IS NOT NULL`,
        sql`${callTranscripts.endedAt} >= ${cutoff.toISOString()}`,
      ),
    )
    .orderBy(desc(callTranscripts.endedAt))
    .limit(1);

  const row = rows[0];
  if (!row || !row.endedAt) return null;
  // If the most recent call ended cleanly or was user-cancelled, the user
  // has moved on — suppress any prior-drop context.
  if (row.cancelled || row.endReason === 'user_ended') return null;

  // Pull the touched-page slugs from this transcript's wiki_log row, if
  // ingestion has run yet. If not, the agent will just have to ask "what
  // were we talking about" the soft way.
  const logRows = await db.execute<{ slugs: string[] }>(sql`
    SELECT (ref->>'slugs')::jsonb #>> '{}' AS slugs
    FROM wiki_log
    WHERE user_id = ${userId}
      AND kind = 'ingest'
      AND ref->>'transcriptId' = ${row.id}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  let touchedSlugs: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: postgres-driver row shape varies; defensive parse below
  const rawSlugs = (logRows[0] as any)?.slugs;
  if (typeof rawSlugs === 'string') {
    try {
      const parsed = JSON.parse(rawSlugs);
      if (Array.isArray(parsed)) touchedSlugs = parsed.filter((s) => typeof s === 'string');
    } catch {
      /* ignore */
    }
  } else if (Array.isArray(rawSlugs)) {
    touchedSlugs = rawSlugs.filter((s: unknown) => typeof s === 'string');
  }

  return {
    endedAt: row.endedAt,
    endReason: row.endReason ?? 'unknown',
    touchedSlugs,
  };
}

// Pull all in-flight todos for this user (status IN ('todo', 'in-progress')).
// Audri walks in knowing the user's actual open list. Each row carries title
// + status + assignee (resolved to agent slug) + due date. The parent_page_id
// is resolved to the parent's title so the rendered list can group by
// "associated wiki page" the same way the Todos plugin UX does. Aliased
// self-join on wiki_pages: one alias = the todo's own page (for title), the
// other = the parent.
//
// No hard cap on count here — the renderer truncates if the user has a huge
// list. Most users carry tens of in-flight todos at most; cheaper to fetch
// all than to make the model wonder what's hidden.
async function fetchInflightTodos(userId: string): Promise<InflightTodo[]> {
  const todoPage = wikiPages;
  const parentPage = aliasedTable(wikiPages, 'parent_page');
  const rows = await db
    .select({
      pageId: todos.pageId,
      title: todoPage.title,
      status: todos.status,
      parentTitle: parentPage.title,
      assigneeAgentSlug: agents.slug,
      dueDate: todos.dueDate,
    })
    .from(todos)
    .innerJoin(todoPage, eq(todoPage.id, todos.pageId))
    .leftJoin(parentPage, eq(parentPage.id, todos.parentPageId))
    .leftJoin(agents, eq(agents.id, todos.assigneeAgentId))
    .where(
      and(
        eq(todos.userId, userId),
        or(eq(todos.status, 'todo'), eq(todos.status, 'in-progress')),
        isNull(todoPage.tombstonedAt),
      ),
    )
    .orderBy(desc(todos.updatedAt));

  return rows.map((r) => ({
    pageId: r.pageId,
    title: r.title,
    status: r.status as 'todo' | 'in-progress',
    parentTitle: r.parentTitle,
    assigneeAgentSlug: r.assigneeAgentSlug,
    dueDate: r.dueDate,
  }));
}

// Pull pending agent_open_items for this (user, agent) pair, ranked by
// priority desc, createdAt desc. Composer-only read — does NOT bump
// `surfaced_at`; that's the post-call resolution pass's job (v0.2 item #6).
// Keeping the write separate means items stay surfacable across multiple
// calls until the agent actually delivers them, which is the right behavior
// for Stage-2 manual-seed testing.
async function fetchPendingOpenItems(userId: string, agentId: string): Promise<OpenItem[]> {
  const rows = await db
    .select({
      id: agentOpenItems.id,
      kind: agentOpenItems.kind,
      topic: agentOpenItems.topic,
      bodyText: agentOpenItems.bodyText,
      priority: agentOpenItems.priority,
      createdAt: agentOpenItems.createdAt,
    })
    .from(agentOpenItems)
    .where(
      and(
        eq(agentOpenItems.userId, userId),
        eq(agentOpenItems.agentId, agentId),
        eq(agentOpenItems.status, 'pending'),
      ),
    )
    .orderBy(desc(agentOpenItems.priority), desc(agentOpenItems.createdAt))
    .limit(OPEN_ITEMS_PER_CALL_LIMIT);

  return rows as OpenItem[];
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n).trimEnd()}…`;
}

// Render preload data into the markdown block injected into the system
// prompt. Sections are explicitly labeled so the model knows the provenance
// (profile = facts about the user, agent notes = your private observations,
// recent pages = where activity has been concentrated).
export function renderPreloadBlock(data: PreloadData): string {
  if (
    data.profile.length === 0 &&
    data.agentNotes.length === 0 &&
    data.recentPages.length === 0 &&
    data.wikiStructure.length === 0 &&
    data.openItems.length === 0 &&
    data.inflightTodos.length === 0 &&
    !data.incompleteCall
  ) {
    return '';
  }

  const parts: string[] = ['# What you know about the user'];

  if (data.incompleteCall) {
    parts.push('', '## Last call cut off', renderIncompleteCall(data.incompleteCall));
  }

  if (data.profile.length > 0) {
    parts.push('', '## Profile', renderPages(data.profile));
  }

  if (data.agentNotes.length > 0) {
    parts.push(
      '',
      '## Your private notes (agent-scope)',
      'These are observations you’ve recorded across past conversations. The user does not see them directly.',
      renderPages(data.agentNotes),
    );
  }

  if (data.wikiStructure.length > 0) {
    parts.push(
      '',
      '## Notes structure (top-level pages + immediate children)',
      "Use this to reason about WHERE in the user's notes a new topic might fit. When the user introduces a substantial new entity and the structure is ambiguous, ask them — see the notes-structure section in your scaffolding.",
      renderWikiStructure(data.wikiStructure),
    );
  }

  if (data.recentPages.length > 0) {
    parts.push('', '## Recently active notes', renderRecentPages(data.recentPages));
  }

  if (data.inflightTodos.length > 0) {
    parts.push('', '## Open todos', renderInflightTodos(data.inflightTodos));
  }

  if (data.openItems.length > 0) {
    parts.push(
      '',
      '## Open items you’ve been holding for this user',
      renderOpenItems(data.openItems),
    );
  }

  parts.push(
    '',
    '---',
    'Use this context naturally. Don’t recite it back — but reference it when relevant ("you mentioned X last time…", "I know you’re working on Y…"). If something seems missing or stale, you can ask. Never tell the user "I don\'t know anything about you" — you do; it\'s above.',
  );

  if (data.incompleteCall) {
    parts.push(
      '',
      'Special: your last call ended unexpectedly (see "Last call cut off" above). Open this call by acknowledging that briefly and offering to pick up where you left off — but don\'t insist; let the user redirect if they\'ve moved on.',
    );
  }

  return parts.join('\n');
}

function renderIncompleteCall(c: IncompleteCall): string {
  const when = formatRelative(c.endedAt);
  const reasonLabel: Record<string, string> = {
    silence_timeout: 'silence timeout',
    network_drop: 'network dropped',
    app_backgrounded: 'app went to background',
    cancelled: 'cancelled',
  };
  const reason = reasonLabel[c.endReason] ?? c.endReason;
  const lines = [`Ended ${when} — reason: ${reason}.`];
  if (c.touchedSlugs.length > 0) {
    lines.push(
      `Topics covered before the cutoff: ${c.touchedSlugs.map((s) => `\`${s}\``).join(', ')}.`,
    );
  } else {
    lines.push('No substantive topics had been extracted yet.');
  }
  return lines.join('\n');
}

function renderPages(pages: PageWithSections[]): string {
  return pages
    .map((p) => {
      const header = `### ${p.title} (\`${p.slug}\`)`;
      const abstract = p.abstract ?? p.agentAbstract;
      const sectionText = p.sections
        .map((s) => (s.title ? `**${s.title}**\n${s.content}` : s.content))
        .join('\n\n');
      return [header, abstract, '', sectionText].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

function renderRecentPages(pages: RecentPage[]): string {
  return pages
    .map((p) => `- \`${p.slug}\` (${p.scope}, ${formatRelative(p.updatedAt)}) — ${p.agentAbstract}`)
    .join('\n');
}

// Render the in-flight todos, grouped by parent_page_id title the same way
// the Todos plugin's swimlanes group them. Audri's job here is to KNOW the
// list — not recite it. The header guidance tells the agent how to use it
// (don't dump, reference when contextually relevant). Per-row format keeps
// status + assignee + due-date inline; "general" (no parent) sorts first.
function renderInflightTodos(items: InflightTodo[]): string {
  // Group by parent title.
  const byParent = new Map<string, InflightTodo[]>();
  for (const item of items) {
    const key = item.parentTitle ?? 'General';
    const list = byParent.get(key) ?? [];
    list.push(item);
    byParent.set(key, list);
  }

  // Format one todo row. Status badge only if 'in-progress' (most are 'todo');
  // assignee badge only if non-user (most are user-owned). Due date inline
  // when present. Keep terse — voice context.
  const formatRow = (t: InflightTodo): string => {
    const badges: string[] = [];
    if (t.status === 'in-progress') badges.push('in-progress');
    if (t.assigneeAgentSlug) badges.push(`assigned to YOU (${t.assigneeAgentSlug})`);
    if (t.dueDate) badges.push(`due ${t.dueDate.toISOString().slice(0, 10)}`);
    const badgeText = badges.length > 0 ? ` _(${badges.join(', ')})_` : '';
    return `- ${t.title}${badgeText}`;
  };

  const parts: string[] = [
    "What the user has on their plate right now. Status is 'todo' or 'in-progress' only — completed and archived are hidden. Items grouped by their associated wiki page; 'General' = no specific association.",
    '',
    '**Delivery posture:**',
    "- Don't recite or list these unprompted. Use them like background context — the same way you'd know what someone's working on without needing to bring it up every minute.",
    '- When the user mentions a topic, you can naturally surface a related todo: "you had a todo to follow up with Alex on that — want me to track when you do?"',
    '- **Todos assigned to YOU** are commitments you\'ve made back to the user ("I\'ll send you a summary", "I\'ll text you a reminder"). Be aware of them — the user can hold you accountable. If the user mentions one, deliver if you can, or own that you haven\'t yet.',
    "- If something seems stale or worth dropping, you can gently ask the user whether to archive it. Don't do this often — the user manages their own list.",
  ];

  // General first, then alphabetical.
  const generalList = byParent.get('General');
  if (generalList && generalList.length > 0) {
    parts.push('', '### General');
    for (const t of generalList) parts.push(formatRow(t));
  }
  const sortedGroups = [...byParent.entries()]
    .filter(([k]) => k !== 'General')
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [parent, list] of sortedGroups) {
    parts.push('', `### Under \`${parent}\``);
    for (const t of list) parts.push(formatRow(t));
  }

  return parts.join('\n');
}

// Render the open-items queue with delivery guidance. Two kinds need very
// different framing: `question` items are gap-fillers the persona has been
// quietly wondering about (deliver as light curiosity, never an interrogation),
// `info_share` items are proactive enrichments the persona wants to introduce
// (deliver only when contextually earned, never as a non-sequitur). The body
// of each item is the candidate content; the persona handles natural-language
// framing on its own.
function renderOpenItems(items: OpenItem[]): string {
  const questions = items.filter((i) => i.kind === 'question');
  const infoShares = items.filter((i) => i.kind === 'info_share');

  const parts: string[] = [
    'These are items you (this persona specifically) have been holding to raise with the user. They were emitted by your own reflection between calls — they represent your curiosity and what you’d like to share, not the user’s pending work.',
    '',
    '**Delivery posture:**',
    '- **Questions** are gentle curiosity, not an interview. Surface ONE per call at most, and only when a natural opening appears — never break flow to ask. If no opening surfaces, drop it; you’ll see it again next call.',
    '- **Info-shares** must be contextually earned. Only weave one in when the conversation is already in its neighborhood. A non-sequitur info-share is worse than not delivering it.',
    '- Never list these or announce them ("I had a few things to ask..."). They are private prompts to YOU, delivered only as the moment allows.',
    "- Don't try to clear the queue. Most calls will surface zero or one of these. That's fine — the user's conversation comes first.",
  ];

  if (questions.length > 0) {
    parts.push('', '### Questions you’d like to ask');
    for (const q of questions) {
      parts.push(`- *${q.topic}* — ${q.bodyText}`);
    }
  }

  if (infoShares.length > 0) {
    parts.push('', '### Things you’d like to share');
    for (const s of infoShares) {
      parts.push(`- *${s.topic}* — ${s.bodyText}`);
    }
  }

  return parts.join('\n');
}

function renderWikiStructure(nodes: WikiStructureNode[]): string {
  return nodes
    .map((n) => {
      const head = `- **${n.title}** \`${n.slug}\` (\`${n.type}\`) — ${n.agentAbstract}`;
      if (n.children.length === 0) return head;
      const childLines = n.children.map(
        (c) => `  - ${c.title} \`${c.slug}\` (\`${c.type}\`) — ${c.agentAbstract}`,
      );
      const more = n.childrenTruncated ? `  - …and more under \`${n.slug}\` (truncated)` : null;
      return [head, ...childLines, ...(more ? [more] : [])].join('\n');
    })
    .join('\n');
}

function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
}
