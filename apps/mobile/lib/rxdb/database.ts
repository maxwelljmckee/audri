// Singleton RxDB database for the mobile app.
//
// Storage: in-memory (RxDB 14 + free-tier on RN has no good persistent
// adapter; rxdb-premium SQLite would close that gap. Acceptable for MVP since
// initial Supabase sync is fast and re-runs on each cold start.)

import { type RxCollection, type RxDatabase, addRxPlugin, createRxDatabase } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import {
  type AgentOpenItemDoc,
  type AgentTaskDoc,
  type CallTranscriptDoc,
  type ResearchOutputDoc,
  type TodoDoc,
  type WikiPageDoc,
  type WikiSectionDoc,
  type WikiSectionTranscriptDoc,
  agentOpenItemSchema,
  agentTaskSchema,
  callTranscriptSchema,
  researchOutputSchema,
  todoSchema,
  wikiPageSchema,
  wikiSectionSchema,
  wikiSectionTranscriptSchema,
} from './schemas';

// RxDB's dev-mode plugin explicitly throws if loaded in production (deliberate
// guard — so devs notice they shipped a debug-only plugin). Metro replaces
// __DEV__ with `false` in release bundles, so this whole call gets dead-code-
// eliminated from TestFlight / App Store builds.
if (__DEV__) {
  addRxPlugin(RxDBDevModePlugin);
}
addRxPlugin(RxDBQueryBuilderPlugin);

export type WikiPageCollection = RxCollection<WikiPageDoc>;
export type WikiSectionCollection = RxCollection<WikiSectionDoc>;
export type ResearchOutputCollection = RxCollection<ResearchOutputDoc>;
export type AgentTaskCollection = RxCollection<AgentTaskDoc>;
export type AgentOpenItemCollection = RxCollection<AgentOpenItemDoc>;
export type CallTranscriptCollection = RxCollection<CallTranscriptDoc>;
export type WikiSectionTranscriptCollection = RxCollection<WikiSectionTranscriptDoc>;
export type TodoCollection = RxCollection<TodoDoc>;

export interface AudriCollections {
  wiki_pages: WikiPageCollection;
  wiki_sections: WikiSectionCollection;
  research_outputs: ResearchOutputCollection;
  agent_tasks: AgentTaskCollection;
  agent_open_items: AgentOpenItemCollection;
  call_transcripts: CallTranscriptCollection;
  wiki_section_transcripts: WikiSectionTranscriptCollection;
  todos: TodoCollection;
}

export type AudriDatabase = RxDatabase<AudriCollections>;

let _dbPromise: Promise<AudriDatabase> | null = null;

export function getDatabase(): Promise<AudriDatabase> {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const db = await createRxDatabase<AudriCollections>({
        name: 'audri',
        storage: getRxStorageMemory(),
        ignoreDuplicate: true,
      });
      await db.addCollections({
        wiki_pages: { schema: wikiPageSchema },
        wiki_sections: { schema: wikiSectionSchema },
        research_outputs: { schema: researchOutputSchema },
        agent_tasks: { schema: agentTaskSchema },
        agent_open_items: { schema: agentOpenItemSchema },
        call_transcripts: { schema: callTranscriptSchema },
        wiki_section_transcripts: { schema: wikiSectionTranscriptSchema },
        todos: { schema: todoSchema },
      });
      return db;
    })();
  }
  return _dbPromise;
}
