// Modal-style screen for setting / clearing the monthly spending limit.
// Reachable from the Usage screen's limit card.
//
// v0.2.1 is soft-only — this UI sets the limit on user_settings; nothing
// gates inference yet. The Usage screen renders the progress bar +
// warning banner against the same fields.

import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { updateSpendingLimit, useUsage } from '../../lib/useUsage';
import { PluginBackRow } from '../PluginStack';
import type { AccountStackParamList } from './AccountNavigation';

export function SetLimitScreen({
  navigation,
}: NativeStackScreenProps<AccountStackParamList, 'SetLimit'>) {
  // Load current usage to seed the inputs with the existing limit, if any.
  const { state } = useUsage();
  const [dollarsInput, setDollarsInput] = useState('');
  const [threshold, setThreshold] = useState(0.8);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed inputs once usage data lands.
  useEffect(() => {
    if (state.status === 'ready') {
      if (state.data.limit.cents !== null) {
        setDollarsInput((state.data.limit.cents / 100).toFixed(2));
      }
      setThreshold(state.data.limit.warningThreshold);
    }
  }, [state]);

  async function save() {
    setError(null);
    setSubmitting(true);
    try {
      const trimmed = dollarsInput.trim();
      const limitCents = trimmed === '' ? null : Math.round(Number.parseFloat(trimmed) * 100);
      if (limitCents !== null && (!Number.isFinite(limitCents) || limitCents < 0)) {
        setError('Limit must be a non-negative dollar amount, or empty to clear.');
        setSubmitting(false);
        return;
      }
      const ok = await updateSpendingLimit({ limitCents, threshold });
      if (!ok) {
        setError('Couldn’t save. Try again.');
        setSubmitting(false);
        return;
      }
      navigation.goBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  async function clearLimit() {
    setError(null);
    setSubmitting(true);
    try {
      const ok = await updateSpendingLimit({ limitCents: null });
      if (!ok) {
        setError('Couldn’t clear. Try again.');
        setSubmitting(false);
        return;
      }
      navigation.goBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.flex}>
      <PluginBackRow label="Usage" onPress={() => navigation.goBack()} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>
          <Text style={styles.heading}>Monthly spending limit</Text>
          <Text style={styles.helpText}>
            We’ll show a progress bar on the Usage screen and a soft warning when you cross your
            threshold. Hard enforcement is coming soon — for now this is just a heads-up.
          </Text>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Monthly limit (USD)</Text>
            <View style={styles.dollarInputRow}>
              <Text style={styles.dollarSign}>$</Text>
              <TextInput
                style={styles.dollarInput}
                value={dollarsInput}
                onChangeText={setDollarsInput}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor="#3f5a83"
                editable={!submitting}
              />
            </View>
            <Text style={styles.fieldHint}>Leave blank to remove the limit.</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>
              Warning at {Math.round(threshold * 100)}% of limit
            </Text>
            <View style={styles.thresholdRow}>
              {[0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((value) => (
                <Pressable
                  key={value}
                  style={[styles.thresholdChip, threshold === value && styles.thresholdChipActive]}
                  onPress={() => setThreshold(value)}
                >
                  <Text
                    style={[
                      styles.thresholdChipLabel,
                      threshold === value && styles.thresholdChipLabelActive,
                    ]}
                  >
                    {Math.round(value * 100)}%
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {error && (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle-outline" size={14} color="#f87171" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <View style={styles.actions}>
            <Pressable style={styles.primaryButton} onPress={save} disabled={submitting}>
              {submitting ? (
                <ActivityIndicator color="#0a1628" />
              ) : (
                <Text style={styles.primaryButtonLabel}>Save</Text>
              )}
            </Pressable>
            {state.status === 'ready' && state.data.limit.cents !== null && (
              <Pressable style={styles.secondaryButton} onPress={clearLimit} disabled={submitting}>
                <Text style={styles.secondaryButtonLabel}>Clear limit</Text>
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { paddingHorizontal: 16, paddingTop: 16, gap: 16 },
  heading: { color: '#e8f1ff', fontSize: 20, fontWeight: '600' },
  helpText: { color: '#7aa3d4', fontSize: 13, lineHeight: 18 },

  field: { gap: 8 },
  fieldLabel: {
    color: '#7aa3d4',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  fieldHint: { color: '#5f7e9f', fontSize: 11 },

  dollarInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0e1c30',
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  dollarSign: { color: '#7aa3d4', fontSize: 18, marginRight: 4 },
  dollarInput: { flex: 1, color: '#e8f1ff', fontSize: 18, paddingVertical: 12 },

  thresholdRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thresholdChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#11203a',
  },
  thresholdChipActive: { backgroundColor: '#4d8fdb' },
  thresholdChipLabel: { color: '#7aa3d4', fontSize: 13 },
  thresholdChipLabelActive: { color: '#0a1628', fontWeight: '600' },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#2a1414',
    borderRadius: 6,
  },
  errorText: { color: '#f87171', fontSize: 12, flex: 1 },

  actions: { gap: 8, marginTop: 8 },
  primaryButton: {
    backgroundColor: '#4d8fdb',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryButtonLabel: { color: '#0a1628', fontSize: 15, fontWeight: '600' },
  secondaryButton: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryButtonLabel: { color: '#f87171', fontSize: 14 },
});
