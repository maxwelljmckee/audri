// Notes pending / failure banner. Surfaced at the top of the Notes plugin.
//
// Reads from `call_transcripts.ingestion_status` directly (per DEC-B
// resolution 2026-05-10): the column already tracks ingestion lifecycle, so
// no need to pollute agent_tasks with system-job rows. Three states:
//
//   pending|running   → spinner + "we're working on it" message
//   failed|partial    → error chrome + retry CTA hitting POST /calls/:id/retry-ingest
//   skipped_over_cap  → cap chrome + "raise limit" deep-link to Usage screen
//
// Failures stack: if multiple calls failed ingestion, a single banner
// surfaces with a "Retry all" affordance. Rendered together when multiple
// states are present, with the actionable ones (failed / over-cap) taking
// priority over the passive pending banner.

import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  useActiveIngestionTranscripts,
  useFailedIngestionTranscripts,
  useOverCapTranscripts,
} from '../../lib/rxdb/useCallTranscripts';
import { captureClientError } from '../../lib/sentry';
import { supabase } from '../../lib/supabase';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export function WikiPendingBanner() {
  const active = useActiveIngestionTranscripts();
  const failed = useFailedIngestionTranscripts();
  const overCap = useOverCapTranscripts();
  const [retrying, setRetrying] = useState(false);

  if (active.length === 0 && failed.length === 0 && overCap.length === 0) return null;

  return (
    <View>
      {overCap.length > 0 && <OverCapBanner count={overCap.length} />}
      {failed.length > 0 && (
        <FailedBanner
          count={failed.length}
          onRetry={async () => {
            setRetrying(true);
            try {
              const { data: sessionData } = await supabase.auth.getSession();
              const accessToken = sessionData.session?.access_token;
              if (!accessToken) return;
              const responses = await Promise.all(
                failed.map((t) =>
                  fetch(`${API_URL}/calls/${t.session_id}/retry-ingest`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${accessToken}` },
                  }),
                ),
              );
              const failures = responses.filter((r) => !r.ok);
              if (failures.length > 0) {
                captureClientError(
                  'retry-ingest',
                  new Error(
                    `retry-ingest returned non-OK for ${failures.length}/${responses.length}: ${failures[0]?.status}`,
                  ),
                );
              }
            } catch (err) {
              captureClientError('retry-ingest', err);
            } finally {
              setRetrying(false);
            }
          }}
          retrying={retrying}
        />
      )}
      {active.length > 0 && <PendingBanner count={active.length} />}
    </View>
  );
}

function OverCapBanner({ count }: { count: number }) {
  // Cross-plugin navigation isn't trivial from the Notes overlay
  // (Account lives in its own plugin stack), so we point the user at
  // the path verbally rather than deep-linking for now. Direct
  // deep-link is a v0.4 polish item — pairs with the broader settings
  // surface work.
  const message =
    count === 1
      ? "Last call's ingestion was skipped — monthly spending limit reached. Raise the limit in Account → Usage."
      : `${count} ingestions skipped — monthly spending limit reached. Raise the limit in Account → Usage.`;
  return (
    <View style={[styles.banner, styles.bannerOverCap]}>
      <Ionicons name="wallet-outline" size={16} color="#fbbf24" />
      <Text style={[styles.text, styles.textOverCap]} numberOfLines={3}>
        {message}
      </Text>
    </View>
  );
}

function PendingBanner({ count }: { count: number }) {
  const message =
    count === 1
      ? 'Ingesting your last call — new notes arrive in a moment.'
      : `Ingesting ${count} calls — new notes arrive in a moment.`;
  return (
    <View style={styles.banner}>
      <ActivityIndicator color="#4d8fdb" size="small" />
      <Text style={styles.text} numberOfLines={2}>
        {message}
      </Text>
      <Ionicons name="time-outline" size={14} color="#7aa3d4" />
    </View>
  );
}

function FailedBanner({
  count,
  onRetry,
  retrying,
}: {
  count: number;
  onRetry: () => void | Promise<void>;
  retrying: boolean;
}) {
  const message =
    count === 1
      ? 'A call failed to ingest. Tap retry to try again.'
      : `${count} calls failed to ingest. Tap retry to try again.`;
  return (
    <View style={[styles.banner, styles.bannerFailed]}>
      <Ionicons name="alert-circle-outline" size={16} color="#f87171" />
      <Text style={[styles.text, styles.textFailed]} numberOfLines={2}>
        {message}
      </Text>
      <Pressable
        onPress={() => void onRetry()}
        disabled={retrying}
        style={[styles.retryButton, retrying && { opacity: 0.5 }]}
        hitSlop={6}
      >
        {retrying ? (
          <ActivityIndicator color="#f87171" size="small" />
        ) : (
          <Text style={styles.retryLabel}>Retry</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#0e1c30',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
  },
  bannerFailed: {
    backgroundColor: '#2a1414',
    borderBottomColor: '#5a2828',
  },
  bannerOverCap: {
    backgroundColor: '#2a2114',
    borderBottomColor: '#5a4428',
  },
  text: {
    flex: 1,
    color: '#7aa3d4',
    fontSize: 12,
    lineHeight: 16,
  },
  textFailed: {
    color: '#f87171',
  },
  textOverCap: {
    color: '#fbbf24',
  },
  retryButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: '#3a1c1c',
    minWidth: 50,
    alignItems: 'center',
  },
  retryLabel: {
    color: '#f87171',
    fontSize: 12,
    fontWeight: '600',
  },
});
