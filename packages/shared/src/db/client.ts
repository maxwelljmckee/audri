import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

function createDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const queryClient = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    prepare: false,
  });
  return drizzle(queryClient, { schema });
}

export const db = createDb();
export type Db = typeof db;
