import { type SupabaseClient, createClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

// Service-role Supabase client. Used to verify JWTs and (V1+) admin operations.
// Has bypassrls — never accept user-controlled inputs unsanitized.
export function getSupabaseAdmin(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
