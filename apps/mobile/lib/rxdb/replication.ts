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
import { supabase } from '../supabase';
import { getDatabase } from './database';

const REPLICATION_VERSION = 'v1';

export interface ReplicationHandle {
  // biome-ignore lint/suspicious/noExplicitAny: SupabaseReplication is a generic-heavy type from rxdb-supabase
  replications: any[];
  stop: () => Promise<void>;
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
      push: {},
    });

    const wikiSectionsRepl = new SupabaseReplication({
      supabaseClient: supabase,
      collection: db.collections.wiki_sections,
      replicationIdentifier: `audri:wiki_sections:${REPLICATION_VERSION}`,
      deletedField: '_deleted',
      pull: { batchSize: 100, lastModifiedField: 'updated_at' },
      push: {},
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

    _active = {
      replications: [wikiPagesRepl, wikiSectionsRepl, researchOutputsRepl],
      stop: async () => {
        await Promise.all([
          wikiPagesRepl.cancel(),
          wikiSectionsRepl.cancel(),
          researchOutputsRepl.cancel(),
        ]);
        _active = null;
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
