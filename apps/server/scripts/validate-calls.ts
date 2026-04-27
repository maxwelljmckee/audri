// End-to-end validation for /calls/start + /calls/:session_id/end (slice 3).
// 1. Creates a test user via admin API + signs in to get a JWT.
// 2. Fires the seed webhook so the user has the default Assistant agent.
// 3. POST /calls/start → confirms ephemeralToken returned.
// 4. POST /calls/{sessionId}/end with fake transcript → confirms row written.
// 5. Re-fire /end → confirms idempotent "already_ended".
// 6. Cleanup.
//
// Run: pnpm exec tsx --env-file=../../.env.local scripts/validate-calls.ts

import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3000';

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const dbUrl = process.env.DATABASE_URL;
  const webhookSecret = process.env.SUPABASE_WEBHOOK_SECRET;
  if (!url || !serviceKey || !anonKey || !dbUrl || !webhookSecret) {
    throw new Error('Missing env');
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  const sql = postgres(dbUrl, { prepare: false });

  const email = `calls-test-${Date.now()}@audri.test`;
  const password = `audri-test-${Date.now()}`;
  let userId: string | undefined;

  try {
    console.log(`[1/6] creating test user…`);
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !created.user) throw createErr ?? new Error('no user');
    userId = created.user.id;

    console.log('[2/6] firing seed webhook…');
    const seed = await fetch(`${SERVER_URL}/webhooks/supabase-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: webhookSecret },
      body: JSON.stringify({
        type: 'INSERT',
        schema: 'auth',
        table: 'users',
        record: { id: userId, email },
        old_record: null,
      }),
    });
    if (!seed.ok) throw new Error(`seed failed: ${seed.status}`);

    console.log('[3/6] signing in to get JWT…');
    const { data: session, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
    if (signInErr || !session.session) throw signInErr ?? new Error('no session');
    const jwt = session.session.access_token;

    console.log('[4/6] POST /calls/start…');
    const startRes = await fetch(`${SERVER_URL}/calls/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ agent_slug: 'assistant', call_type: 'generic' }),
    });
    const startBody = await startRes.json();
    console.log('     →', startRes.status, JSON.stringify(startBody, null, 2));
    if (!startRes.ok) throw new Error('start failed');
    if (!startBody.ephemeralToken || !startBody.sessionId) throw new Error('missing token/sessionId');
    const sessionId: string = startBody.sessionId;

    console.log('[5/6] POST /calls/{sessionId}/end (first call)…');
    const endRes = await fetch(`${SERVER_URL}/calls/${sessionId}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        transcript: [{ role: 'user', text: 'hello' }, { role: 'agent', text: 'hi there' }],
        started_at: new Date(Date.now() - 60_000).toISOString(),
        ended_at: new Date().toISOString(),
        end_reason: 'user_ended',
      }),
    });
    const endBody = await endRes.json();
    console.log('     →', endRes.status, endBody);
    if (endBody.status !== 'ended') throw new Error(`expected ended, got ${endBody.status}`);

    const [row] = await sql`SELECT ended_at, content FROM call_transcripts WHERE session_id = ${sessionId}`;
    if (!row?.ended_at) throw new Error('row not updated');
    console.log(`     row content turns: ${(row.content as unknown[]).length}`);

    console.log('[6/6] re-fire /end (idempotency)…');
    const end2 = await fetch(`${SERVER_URL}/calls/${sessionId}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        transcript: [],
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      }),
    });
    const end2Body = await end2.json();
    console.log('     →', end2.status, end2Body);
    if (end2Body.status !== 'already_ended') throw new Error('idempotency broken');

    console.log('\n✅ calls validation passed');
  } catch (err) {
    console.error('\n❌ failed:', err);
    process.exitCode = 1;
  } finally {
    if (userId) {
      try { await admin.auth.admin.deleteUser(userId); } catch {}
    }
    await sql.end();
  }
}

main();
