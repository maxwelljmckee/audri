// Singleton RxDB database for the mobile app.
//
// Storage: in-memory (RxDB 14 + free-tier on RN has no good persistent
// adapter; rxdb-premium SQLite would close that gap. Acceptable for MVP since
// initial Supabase sync is fast and re-runs on each cold start.)

import { addRxPlugin, createRxDatabase, type RxCollection, type RxDatabase } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import {
  type AgentTaskDoc,
  type ResearchOutputDoc,
  type WikiPageDoc,
  type WikiSectionDoc,
  agentTaskSchema,
  researchOutputSchema,
  wikiPageSchema,
  wikiSectionSchema,
} from './schemas';

addRxPlugin(RxDBDevModePlugin);
addRxPlugin(RxDBQueryBuilderPlugin);

export type WikiPageCollection = RxCollection<WikiPageDoc>;
export type WikiSectionCollection = RxCollection<WikiSectionDoc>;
export type ResearchOutputCollection = RxCollection<ResearchOutputDoc>;
export type AgentTaskCollection = RxCollection<AgentTaskDoc>;

export interface AudriCollections {
  wiki_pages: WikiPageCollection;
  wiki_sections: WikiSectionCollection;
  research_outputs: ResearchOutputCollection;
  agent_tasks: AgentTaskCollection;
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
      });
      return db;
    })();
  }
  return _dbPromise;
}
