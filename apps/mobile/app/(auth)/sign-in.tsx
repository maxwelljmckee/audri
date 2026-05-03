import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GlassButton } from '../../components/buttons';
import { supabase } from '../../lib/supabase';

WebBrowser.maybeCompleteAuthSession();

export default function SignInScreen() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function signInWithGoogle() {
    setErr(null);
    setBusy(true);
    try {
      // No leading slash → produces `audri://auth-callback` (two slashes), which
      // matches typical Supabase redirect-URL allowlist patterns. A leading slash
      // would produce `audri:///auth-callback` and fail the allowlist check.
      const redirectTo = Linking.createURL('auth-callback');

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (error) throw error;
      if (!data?.url) throw new Error('no auth url returned');

      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (result.type !== 'success') {
        if (result.type === 'cancel' || result.type === 'dismiss') return;
        throw new Error(`auth flow ended: ${result.type}`);
      }

      // supabase-js defaults to PKCE flow in v2+: callback returns ?code=... in the
      // query string, which we exchange for a session server-side via Supabase.
      // (Implicit-flow legacy: tokens in the URL fragment after #. Handle both.)
      const params = parseAuthUrl(result.url);

      if (params.error || params.error_code) {
        // Supabase relayed an error in the callback — surface the actual reason.
        const desc = params.error_description ?? params.error ?? params.error_code ?? 'unknown';
        throw new Error(`Supabase auth error: ${desc}`);
      }

      if (params.code) {
        const { error: exchangeErr } = await supabase.auth.exchangeCodeForSession(params.code);
        if (exchangeErr) throw exchangeErr;
      } else if (params.access_token && params.refresh_token) {
        const { error: setErr } = await supabase.auth.setSession({
          access_token: params.access_token,
          refresh_token: params.refresh_token,
        });
        if (setErr) throw setErr;
      } else {
        throw new Error(`callback url missing code/tokens: ${result.url.slice(0, 120)}`);
      }
      // onAuthStateChange in (auth)/_layout will redirect to (app).
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Stub handlers — Apple, Facebook, email come online one at a time as
  // their backends are wired. Today: Google only; the others render but
  // no-op so the layout is locked in.
  const noop = () => {};

  return (
    <View className="flex-1 items-center justify-center gap-10 bg-azure-bg px-8">
      <Text
        className="text-azure-text"
        style={{ fontSize: 36, fontFamily: 'Comfortaa_400Regular' }}
      >
        Audri
      </Text>

      <View style={styles.providerRow}>
        <ProviderButton
          label="Google"
          icon="logo-google"
          onPress={signInWithGoogle}
          busy={busy}
          disabled={busy}
        />
        <ProviderButton
          label="Apple"
          icon="logo-apple"
          onPress={noop}
          disabled={busy}
        />
        <ProviderButton
          label="Facebook"
          icon="logo-facebook"
          onPress={noop}
          disabled={busy}
        />
        <ProviderButton
          label="Email"
          icon="mail-outline"
          onPress={noop}
          disabled={busy}
        />
      </View>

      {err && <Text className="text-center text-xs text-red-400">{err}</Text>}
    </View>
  );
}

interface ProviderButtonProps {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}

function ProviderButton({ label, icon, onPress, busy, disabled }: ProviderButtonProps) {
  return (
    <GlassButton
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={`Sign in with ${label}`}
      style={styles.providerButton}
    >
      <Ionicons name={icon} size={26} color="#e8f1ff" />
      {busy ? <View style={styles.busyDot} /> : null}
    </GlassButton>
  );
}

const styles = StyleSheet.create({
  providerRow: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  providerButton: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 14,
  },
  busyDot: {
    position: 'absolute',
    bottom: 8,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#4d8fdb', // azure-accent
  },
});

function parseAuthUrl(url: string): Record<string, string> {
  // PKCE flow: ?code=... in query string. Implicit flow: #...tokens in fragment.
  // Merge both since the callback may use either depending on Supabase config.
  const out: Record<string, string> = {};
  const [, queryAndFrag = ''] = url.split('?');
  const [query = '', fragment = ''] = queryAndFrag.split('#');
  const hashOnly = url.includes('#') && !url.includes('?') ? url.split('#')[1] ?? '' : '';
  for (const part of [query, fragment, hashOnly]) {
    if (!part) continue;
    for (const kv of part.split('&')) {
      const [k, v] = kv.split('=');
      if (k) out[k] = decodeURIComponent(v ?? '');
    }
  }
  return out;
}
