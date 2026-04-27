// Re-export everything from db schema + client for convenience.
// Direct imports `@audri/shared/db/client` and `@audri/shared/db/schema`
// also work for finer-grained tree-shaking.
export * from './client.js';
export * from './schema/index.js';

// Re-export the drizzle-orm helpers consumers need (eq, and, sql, etc.) so
// they always come from the SAME physical drizzle-orm instance as our schema
// + client. Avoids the "two drizzle-orms in node_modules" SQL<unknown> type
// mismatch under pnpm + workspace deps.
export {
  and,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  isNull,
  isNotNull,
  inArray,
  notInArray,
  exists,
  notExists,
  sql,
  desc,
  asc,
  or,
  not,
} from 'drizzle-orm';
export { alias as aliasedTable } from 'drizzle-orm/pg-core';
