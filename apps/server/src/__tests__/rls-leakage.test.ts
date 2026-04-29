// Cross-user / cross-agent RLS leakage tests.
//
// Per todos.md §3 Agent-scope leak-prevention tests. Verifies that:
//   1. Client-role SELECT on wiki_pages WHERE scope='agent' returns no rows
//      regardless of which user owns them.
//   2. User A can't read user B's user-scope wiki_pages.
//   3. agents projection excludes persona_prompt + user_prompt_notes columns
//      (column-level REVOKE in migration 0010).
//   4. Direct slug-based lookups still respect RLS.
//   5. Client-role INSERT to wiki_pages with scope='agent' is rejected.
//
// THIS TEST FILE IS A SCAFFOLD. It can't run yet — needs:
//   1. A test runner installed (vitest recommended; the workspace has none).
//   2. A dedicated Supabase test project (or careful tear-down on the live
//      one). DO NOT run against the production Supabase project as-is.
//   3. Two real auth.users rows whose JWTs we can mint via supabase.auth.admin
//      (or Supabase's local CLI). Service-role is needed to seed both users
//      + their data; per-user JWTs are needed to prove RLS gates work when
//      acting as the authenticated role.
//
// Run plan once these are wired:
//   pnpm -F @audri/server test
//
// References:
//   - todos.md §3 RLS draft (the test cases above)
//   - apps/server/drizzle/0001_spotty_salo.sql + 0010_rls_hardening.sql
//   - specs/agents-and-scope.md privacy invariants

import { describe, expect, it } from 'vitest';

describe.skip('RLS leakage: cross-user wiki_pages', () => {
  it('user A cannot SELECT user B user-scope pages', async () => {
    // 1. Service-role: insert wiki_pages for user_a + user_b
    // 2. Mint authenticated JWT for user_a
    // 3. Query supabase as user_a: SELECT * FROM wiki_pages
    // 4. Expect: only user_a's pages returned; user_b's absent
    expect(true).toBe(true);
  });

  it('agent-scope rows are invisible to all client queries', async () => {
    // 1. Service-role: insert agent-scope wiki_pages for user_a
    // 2. Query as user_a (the owner): SELECT * FROM wiki_pages WHERE scope='agent'
    // 3. Expect: empty result. RLS policy gates `scope='user'` on SELECT.
    expect(true).toBe(true);
  });

  it('client INSERT with scope=agent is rejected', async () => {
    // 1. Mint user_a JWT
    // 2. Attempt INSERT into wiki_pages with scope='agent', user_id=user_a.id
    // 3. Expect: rejected (no INSERT policy for any scope; RLS deny-default)
    expect(true).toBe(true);
  });
});

describe.skip('RLS column-level: agents persona_prompt is locked', () => {
  it('client SELECT on agents does NOT return persona_prompt column', async () => {
    // 1. Service-role: ensure user_a has a seeded agent
    // 2. Query as user_a: SELECT persona_prompt FROM agents WHERE user_id = auth.uid()
    // 3. Expect: error or null — column REVOKE'd from authenticated role
    expect(true).toBe(true);
  });

  it('client SELECT on agents does NOT return user_prompt_notes column', async () => {
    // Same as above but for user_prompt_notes.
    expect(true).toBe(true);
  });
});

describe.skip('RLS leakage: research_outputs cross-user', () => {
  it('user A cannot read user B research_outputs', async () => {
    expect(true).toBe(true);
  });

  it('research_output_sources/ancestors filter by parent ownership', async () => {
    expect(true).toBe(true);
  });
});

describe.skip('RLS leakage: agent_tasks cross-user', () => {
  it('user A cannot read user B agent_tasks', async () => {
    expect(true).toBe(true);
  });
});
