// Account → Usage screen (v0.2.1). Reads GET /me/usage and renders:
//   1. Monthly total (large)
//   2. Spend-limit progress bar + soft-warning banner (when limit is set)
//   3. Daily bar chart for the current month
//   4. Category pie chart (Live Agent / Web Search / Research / Other)
//   5. Small print: how categories map to underlying inference paths
//
// Hard enforcement of spend caps is deferred to v0.2.2 — this screen is
// purely informational + soft-warning.

import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Pie, PolarChart } from 'victory-native';
import { type UsageData, useUsage } from '../../lib/useUsage';
import { PluginBackRow } from '../PluginStack';
import type { AccountStackParamList } from './AccountNavigation';

// Format cents (NUMERIC, may have 4 decimals of precision) as $X.XX.
// Tiny budgets render as $0.00 — acceptable for a passive readout.
function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function UsageScreen({
  navigation,
}: NativeStackScreenProps<AccountStackParamList, 'Usage'>) {
  const { state, refresh } = useUsage();

  return (
    <View style={styles.flex}>
      <PluginBackRow label="Account" onPress={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={state.status === 'loading'}
            onRefresh={refresh}
            tintColor="#4d8fdb"
          />
        }
      >
        {state.status === 'loading' && (
          <View style={styles.centered}>
            <ActivityIndicator color="#4d8fdb" />
            <Text style={styles.loadingText}>Loading usage…</Text>
          </View>
        )}

        {state.status === 'error' && (
          <View style={styles.centered}>
            <Text style={styles.errorText}>Couldn’t load usage: {state.error}</Text>
            <Pressable style={styles.retryButton} onPress={refresh}>
              <Text style={styles.retryLabel}>Retry</Text>
            </Pressable>
          </View>
        )}

        {state.status === 'ready' && (
          <UsageBody data={state.data} onEditLimit={() => navigation.push('SetLimit')} />
        )}
      </ScrollView>
    </View>
  );
}

function UsageBody({ data, onEditLimit }: { data: UsageData; onEditLimit: () => void }) {
  const { width } = useWindowDimensions();
  const chartWidth = width - 32; // 16 padding each side

  // Pie data — Skia Pie wants `{ value, color, label }`. Filter zero
  // slices so the chart doesn't render empty wedges.
  const pieData = useMemo(() => {
    const entries: Array<{ value: number; color: string; label: string }> = [];
    if (data.byCategory.liveAgent > 0)
      entries.push({
        value: data.byCategory.liveAgent,
        color: '#4d8fdb',
        label: 'Live Agent',
      });
    if (data.byCategory.research > 0)
      entries.push({
        value: data.byCategory.research,
        color: '#7c5fd4',
        label: 'Research',
      });
    if (data.byCategory.webSearch > 0)
      entries.push({
        value: data.byCategory.webSearch,
        color: '#d4a64d',
        label: 'Web Search',
      });
    for (const [kind, value] of Object.entries(data.byCategory.other)) {
      if (value > 0) entries.push({ value, color: '#5f7e9f', label: kind });
    }
    return entries;
  }, [data.byCategory]);

  // Daily bar chart data — fill missing days with 0 across the month so
  // the bars give a calendar-shaped view rather than a gappy histogram.
  const filledDaily = useMemo(
    () => fillMonthDays(data.month, data.daily),
    [data.month, data.daily],
  );
  const maxDaily = useMemo(() => Math.max(...filledDaily.map((d) => d.cents), 1), [filledDaily]);

  return (
    <View style={styles.body}>
      {/* Total + limit. Whole card is tappable → SetLimit screen. */}
      <Pressable onPress={onEditLimit} style={styles.totalCard}>
        <View style={styles.totalCardHeader}>
          <Text style={styles.totalLabel}>{formatMonthLabel(data.month)} spend</Text>
          <Ionicons name="settings-outline" size={14} color="#7aa3d4" />
        </View>
        <Text style={styles.totalValue}>{formatUsd(data.totalCents)}</Text>
        {data.limit.cents !== null ? (
          <View style={styles.limitContainer}>
            <View style={styles.limitBarTrack}>
              <View
                style={[
                  styles.limitBarFill,
                  {
                    width: `${Math.min(100, (data.totalCents / data.limit.cents) * 100)}%`,
                    backgroundColor: data.limit.thresholdReached ? '#f87171' : '#4d8fdb',
                  },
                ]}
              />
            </View>
            <Text style={styles.limitLabel}>
              {formatUsd(data.totalCents)} of {formatUsd(data.limit.cents)} limit · tap to edit
            </Text>
          </View>
        ) : (
          <Text style={styles.setLimitHint}>Tap to set a monthly limit</Text>
        )}
        {data.limit.thresholdReached && (
          <View style={styles.warningBanner}>
            <Ionicons name="alert-circle-outline" size={16} color="#f87171" />
            <Text style={styles.warningText}>
              You’re at {Math.round((data.totalCents / (data.limit.cents ?? 1)) * 100)}% of your
              monthly limit.
            </Text>
          </View>
        )}
      </Pressable>

      {/* Daily bar chart — custom drawing rather than victory's CartesianChart
          since the data is simple and lightweight Skia + View bars give us a
          cleaner look without the cartesian-axis ceremony. */}
      <Section label="Daily">
        <View style={styles.dailyChart}>
          {filledDaily.map((d) => (
            <View key={d.day} style={styles.dailyBarColumn}>
              <View
                style={[
                  styles.dailyBar,
                  {
                    height: Math.max(2, (d.cents / maxDaily) * 80),
                    backgroundColor: d.cents > 0 ? '#4d8fdb' : '#1f2f4d',
                  },
                ]}
              />
            </View>
          ))}
        </View>
        <View style={styles.dailyAxis}>
          <Text style={styles.dailyAxisLabel}>1</Text>
          <Text style={styles.dailyAxisLabel}>{filledDaily.length}</Text>
        </View>
      </Section>

      {/* Category pie */}
      {pieData.length > 0 ? (
        <Section label="By category">
          <View style={[styles.pieContainer, { height: chartWidth * 0.6 }]}>
            <PolarChart data={pieData} labelKey="label" valueKey="value" colorKey="color">
              <Pie.Chart innerRadius="40%" />
            </PolarChart>
          </View>
          <View style={styles.pieLegend}>
            {pieData.map((entry) => (
              <View key={entry.label} style={styles.legendRow}>
                <View style={[styles.legendDot, { backgroundColor: entry.color }]} />
                <Text style={styles.legendLabel}>{entry.label}</Text>
                <Text style={styles.legendValue}>{formatUsd(entry.value)}</Text>
              </View>
            ))}
          </View>
        </Section>
      ) : (
        <Section label="By category">
          <Text style={styles.emptyText}>No spend yet this month.</Text>
        </Section>
      )}

      <Text style={styles.smallPrint}>
        Live Agent includes the call itself, post-call ingestion, and the in-call wiki tools.
        Research is billed separately when Audri runs a research task. Web Search covers web
        grounding calls. Pricing is computed from token counts at standard Gemini rates.
      </Text>
    </View>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

// Format 'YYYY-MM' → 'May 2026' for the human-readable header.
function formatMonthLabel(month: string): string {
  const [yearStr, monthStr] = month.split('-');
  const year = Number.parseInt(yearStr ?? '', 10);
  const monthIdx = Number.parseInt(monthStr ?? '', 10) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIdx)) return month;
  const monthName = new Date(year, monthIdx, 1).toLocaleString('en-US', { month: 'long' });
  return `${monthName} ${year}`;
}

// Pad the daily data so every day of the requested month has an entry —
// even if zero — so the bar chart reads as a calendar timeline.
function fillMonthDays(
  month: string,
  daily: Array<{ day: string; cents: number }>,
): Array<{
  day: string;
  cents: number;
}> {
  const [yearStr, monthStr] = month.split('-');
  const year = Number.parseInt(yearStr ?? '', 10);
  const monthNum = Number.parseInt(monthStr ?? '', 10);
  if (!Number.isFinite(year) || !Number.isFinite(monthNum)) return daily;
  // Number of days in the month: day 0 of next month = last day of this month.
  const dayCount = new Date(year, monthNum, 0).getDate();
  const map = new Map(daily.map((d) => [d.day, d.cents]));
  const out: Array<{ day: string; cents: number }> = [];
  for (let d = 1; d <= dayCount; d++) {
    const key = `${year}-${String(monthNum).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    out.push({ day: key, cents: map.get(key) ?? 0 });
  }
  return out;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scrollContent: { paddingBottom: 40 },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 12 },
  loadingText: { color: '#7aa3d4', fontSize: 13 },
  errorText: { color: '#f87171', fontSize: 13, textAlign: 'center', paddingHorizontal: 24 },
  retryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#11203a',
    borderRadius: 6,
  },
  retryLabel: { color: '#e8f1ff', fontSize: 13 },
  body: { paddingHorizontal: 16, paddingTop: 12, gap: 16 },

  totalCard: {
    backgroundColor: '#0e1c30',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  totalCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  totalLabel: {
    color: '#7aa3d4',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  totalValue: { color: '#e8f1ff', fontSize: 36, fontWeight: '700' },
  setLimitHint: { color: '#5f7e9f', fontSize: 11, marginTop: 4 },

  limitContainer: { marginTop: 8, gap: 6 },
  limitBarTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#1f2f4d',
    overflow: 'hidden',
  },
  limitBarFill: { height: '100%', borderRadius: 3 },
  limitLabel: { color: '#7aa3d4', fontSize: 11 },

  warningBanner: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#2a1414',
    borderRadius: 6,
  },
  warningText: { color: '#f87171', fontSize: 12, flex: 1 },

  section: { gap: 8 },
  sectionLabel: {
    color: '#7aa3d4',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sectionBody: { backgroundColor: '#0e1c30', borderRadius: 10, padding: 12 },

  dailyChart: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 96,
    gap: 2,
    paddingTop: 8,
  },
  dailyBarColumn: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  dailyBar: { width: '100%', borderRadius: 2, minHeight: 2 },
  dailyAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  dailyAxisLabel: { color: '#7aa3d4', fontSize: 10 },

  pieContainer: { paddingHorizontal: 12 },
  pieLegend: { marginTop: 12, gap: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { color: '#e8f1ff', fontSize: 13, flex: 1 },
  legendValue: { color: '#7aa3d4', fontSize: 13 },

  emptyText: { color: '#7aa3d4', fontSize: 12, textAlign: 'center', paddingVertical: 12 },

  smallPrint: {
    color: '#5f7e9f',
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 4,
    marginTop: 4,
  },
});
