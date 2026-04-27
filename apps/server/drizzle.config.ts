import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set (drizzle-kit invocation should use --env-file)');
}

export default defineConfig({
  schema: '../../packages/shared/src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
});
