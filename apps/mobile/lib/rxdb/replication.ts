// Bidirectional Supabase replication for the wiki collections.
//
// Pull: server-side INSERT/UPDATE flows down to client. Includes ingestion
// fan-out writes appearing live during a call.
// Push: client-side UPDATE flows up. Markdown editor edits land here.
//
// RLS gates what the client can read/write — auth.uid() = user_id matches via
// the JWT carried in the Supabase client. Server (service_role) bypasses RLS.
//
// MVP storage is in-memory; each cold start re-syncs from server. Replication
// identifier is versioned so a schema bump can force a full re-sync.

import { SupabaseReplication } from 'rxdb-supabase';
import { captureClientError } from '../sentry';
import { supabase } from '../supabase';
import { getDatabase } from './database';

const REPLICATION_VERSION = 'v1';

// Builds a push.updateHandler that mirrors rxdb-supabase's default behavior
// but excludes the generated `_deleted` column from the UPDATE SET clause.
// Postgres rejects writes to generated columns (428C9: "column can only be
// updated to DEFAULT"), and rxdb-supabase's default handler includes every
// column on the row in the SET clause — so any client-side UPDATE on a
// push-enabled table with a `_deleted` GENERATED ALWAYS column fails.
//
// `_deleted` stays in the WHERE predicate (via `.is(...)`) so the optimistic-
// concurrency check is unchanged: the UPDATE still only applies if every
// expected field still matches in the database.
//
// Note: this does not address the INSERT path. rxdb-supabase's `handleInsertion`
// is not user-customizable (`push.handler` is omitted from the options type),
// so any client-originated INSERT on a generated-column table would still
// fail. None of our push-enabled tables currently take client INSERTs at MVP
// (server endpoints + ingestion own creation), so leave the INSERT side alone
// until that flow lands.
// biome-ignore lint/suspicious/noExplicitAny: rxdb-supabase row type is heavily generic; replicating it here is noise
function makeUpdateHandlerStrippingDeleted(table: string) {
  return async (row: { newDocumentState: any; assumedMasterState?: any }) => {
    const payload: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(row.newDocumentState)) {
      if (field !== '_deleted') payload[field] = value;
    }
    let query = supabase.from(table).update(payload, { count: 'exact' });
    for (const [field, value] of Object.entries(row.assumedMasterState ?? {})) {
      const type = typeof value;
      if (type === 'string' || type === 'number') {
        query = query.eq(field, value);
      } else if (type === 'boolean' || value === null) {
        query = query.is(field, value);
      } else {
        throw new Error(`updateHandler[${table}]: unsupported field of type ${type}`);
      }
    }
    const { error, count } = await query;
    if (error) throw error;
    return count === 1;
  };
}

export interface ReplicationHandle {
  // biome-ignore lint/suspicious/noExplicitAny: SupabaseReplication is a generic-heavy type from rxdb-supabase
  replications: any[];
  stop: () => Promise<void>;
  // Force a manual pull cycle on every collection. Used by pull-to-refresh in
  // plugin overlays — mobile is in-memory storage, so realtime hiccups can
  // leave the local view stale until a re-pull arrives. Pull-to-refresh is
  // the user's manual recourse.
  reSync: () => Promise<void>;
}

let _active: ReplicationHandle | null = null;
// In-flight promise singleton: prevents a second concurrent startReplication()
// (e.g. StrictMode double-mount, or home + onboarding both mounting
// useRxdbReady) from spinning up duplicate Supabase realtime subscriptions
// against the same channel name — which throws "cannot add postgres_changes
// callbacks ... after subscribe()".
let _starting: Promise<ReplicationHandle> | null = null;

export function startReplication(): Promise<ReplicationHandle> {
  if (_active) return Promise.resolve(_active);
  if (_starting) return _starting;

  _starting = (async () => {
    const db = await getDatabase();

    const wikiPagesRepl = new SupabaseReplication({
      supabaseClient: supabase,
      collection: db.collections.wiki_pages,
      replicationIdentifier: `audri:wiki_pages:${REPLICATION_VERSION}`,
      deletedField: '_deleted',
      pull: { batchSize: 50, lastModifiedField: 'updated_at' },
      push: { updateHandler: makeUpdateHandlerStrippingDeleted('wiki_pages') },
    });

    const wikiSectionsRepl = new SupabaseReplication({
      supabaseClient: supabase,
      collection: db.collections.wiki_sections,
      replicationIdentifier: `audri:wiki_sections:${REPLICATION_VERSION}`,
      deletedField: '_deleted',
      pull: { batchSize: 100, lastModifiedField: 'updated_at' },
      push: { updateHandler: makeUpdateHandlerStrippingDeleted('wiki_sections') },
    });

    // research_outputs is read-only client-side (immutable artifact). No push.
    // Sort by generated_at since updated_at isn't on this table.
    const researchOutputsRepl = new SupabaseReplication({
      supabaseClient: supabase,
      collection: db.collections.research_outputs,
      replicationIdentifier: `audri:research_outputs:${REPLICATION_VERSION}`,
      deletedField: '_deleted',
      pull: { batchSize: 50, lastModifiedField: 'generated_at' },
    });

    // agent_tasks is read-only too. Drives the in-flight placeholder UX in
    // each plugin overlay (research / podcast / etc.) so users see queued
    // work instead of a blank list while their task generates.
    const agentTasksRepl = new SupabaseReplication({
      supabaseClient: supabase,
      collection: db.collections.agent_tasks,
      replicationIdentifier: `audri:agent_tasks:${REPLICATION_VERSION}`,
      deletedField: '_deleted',
      pull: { batchSize: 100, lastModifiedField: 'updated_at' },
    });

    // agent_open_items — the v0.2 autonomic-loop queue. Mobile reads via the
    // Agents tile + writes status updates (snooze / dismiss). Server writes
    // come from agent-scope ingestion fan-out (item #4) and the hygiene
    // sweep (item #9). Push enabled so mobile dismiss/snooze flows up.
    const agentOpenItemsRepl = new SupabaseReplication({
      supabaseClient: supabase,
      collection: db.collections.agent_open_items,
      replicationIdentifier: `audri:agent_open_items:${REPLICATION_VERSION}`,
      deletedField: '_deleted',
      pull: { batchSize: 50, lastModifiedField: 'updated_at' },
      push: { updateHandler: makeUpdateHandlerStrippingDeleted('agent_open_items') },
    });

    // call_transcripts — Chat History data source + ingestion-status driver
    // for the Notes pending banner. Read-only client-side (server writes
    // turns + status; mobile never authors). Heavy/PII columns are excluded
    // server-side via the publication allowlist (migration 0016).
    const callTranscriptsRepl = new SupabaseReplication({
      supabaseClient: supabase,
      collection: db.collections.call_transcripts,
      replicationIdentifier: `audri:call_transcripts:${REPLICATION_VERSION}`,
      deletedField: '_deleted',
      pull: { batchSize: 50, lastModifiedField: 'created_at' },
    });

    // wiki_section_transcripts — junction synced for Chat detail's
    // cross-reference panel ("sections this chat produced"). Read-only.
    // No timestamp updates after insert, so use cited_at as the
    // lastModifiedField (insert time).
    const wikiSectionTranscriptsRepl = new SupabaseReplication({
      supabaseClient: supabase,
      collection: db.collections.wiki_section_transcripts,
      replicationIdentifier: `audri:wiki_section_transcripts:${REPLICATION_VERSION}`,
      deletedField: '_deleted',
      pull: { batchSize: 200, lastModifiedField: 'cited_at' },
    });

    // todos sidecar — owns todo lifecycle (status + parent_page_id
    // association). Mobile reads to render swimlane Todos UX and pushes
    // status/parent updates (check-off, archive, re-associate). v0.2.1.
    const todosRepl = new SupabaseReplication({
      supabaseClient: supabase,
      collection: db.collections.todos,
      replicationIdentifier: `audri:todos:${REPLICATION_VERSION}`,
      deletedField: '_deleted',
      pull: { batchSize: 200, lastModifiedField: 'updated_at' },
      push: { updateHandler: makeUpdateHandlerStrippingDeleted('todos') },
    });

    // Surface errors from each replication's error stream — without this,
    // pull/push failures (RLS denials, schema-validation rejections, network
    // hiccups) are silent and the wiki UI just appears empty. Each error
    // routes to Sentry with a per-collection tag so we can triangulate which
    // sync stream failed.
    const subscribeErrors = (
      repl: { error$: { subscribe: (fn: (err: unknown) => void) => unknown } },
      collection: string,
    ) => {
      try {
        repl.error$.subscribe((err: unknown) => {
          captureClientError(`rxdb-replication-${collection}`, err);
          // Also log to console for immediate dev-time visibility — Sentry can
          // be lossy and field-test debugging benefits from raw stderr output.
          console.error(`[rxdb][${collection}] replication error:`, err);
        });
      } catch (e) {
        captureClientError(`rxdb-error-subscribe-${collection}`, e);
      }
    };
    subscribeErrors(wikiPagesRepl, 'wiki_pages');
    subscribeErrors(wikiSectionsRepl, 'wiki_sections');
    subscribeErrors(researchOutputsRepl, 'research_outputs');
    subscribeErrors(agentTasksRepl, 'agent_tasks');
    subscribeErrors(agentOpenItemsRepl, 'agent_open_items');
    subscribeErrors(callTranscriptsRepl, 'call_transcripts');
    subscribeErrors(wikiSectionTranscriptsRepl, 'wiki_section_transcripts');
    subscribeErrors(todosRepl, 'todos');

    const allRepls = [
      wikiPagesRepl,
      wikiSectionsRepl,
      researchOutputsRepl,
      agentTasksRepl,
      agentOpenItemsRepl,
      callTranscriptsRepl,
      wikiSectionTranscriptsRepl,
      todosRepl,
    ];

    _active = {
      replications: allRepls,
      stop: async () => {
        await Promise.all(allRepls.map((r) => r.cancel()));
        _active = null;
      },
      reSync: async () => {
        // RxDB exposes reSync() on each replication; calling it nudges the
        // pull cycle to fire immediately. Errors surface through the existing
        // error subscriptions (subscribeErrors above).
        for (const r of allRepls) {
          try {
            r.reSync();
          } catch (e) {
            captureClientError('rxdb-resync', e);
          }
        }
      },
    };

    return _active;
  })();

  _starting.catch(() => {
    // Allow a retry if the start failed.
    _starting = null;
  });
  _starting.then(() => {
    _starting = null;
  });

  return _starting;
}

export async function stopReplication(): Promise<void> {
  // Wait for any in-flight start so we don't leak a half-started replication.
  if (_starting) {
    try {
      await _starting;
    } catch {
      // start failed; nothing to stop
    }
  }
  if (_active) {
    await _active.stop();
  }
}
