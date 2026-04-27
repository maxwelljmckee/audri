import { pgSchema, uuid } from 'drizzle-orm/pg-core';

// Stub of Supabase Auth's `auth.users` table — used only as an FK target.
// We never read or write it from our code; Supabase Auth (GoTrue) owns it.
// Declared here so Drizzle can emit `REFERENCES auth.users(id)` in our FKs.
const authSchema = pgSchema('auth');

export const authUsers = authSchema.table('users', {
  id: uuid('id').primaryKey(),
});
