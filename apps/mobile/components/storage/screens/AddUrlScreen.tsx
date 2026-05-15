// URL-submission screen — single text input. Submits to POST /urls;
// the worker fetches + extracts in the background.

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
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
import { initiateUrl } from '../../../lib/storage/api';
import { PluginBackRow } from '../../PluginStack';
import type { StorageStackParamList } from '../StorageNavigation';

export function AddUrlScreen({
  navigation,
}: NativeStackScreenProps<StorageStackParamList, 'AddUrl'>) {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = url.trim();
    if (trimmed.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await initiateUrl({ url: trimmed });
      navigation.popToTop();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <PluginBackRow label="Storage" onPress={() => navigation.goBack()} />
      <View style={styles.body}>
        <Text style={styles.title}>Add a URL</Text>
        <Text style={styles.hint}>
          Paste any article, PDF link, or Reddit thread. We'll fetch + extract its content
          for you to attach to Notes when you're ready.
        </Text>
        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="https://…"
          placeholderTextColor="#3f5a83"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          autoFocus
        />
        {error && (
          <Text style={styles.errorText} numberOfLines={3}>
            {error}
          </Text>
        )}
        <Pressable
          onPress={submit}
          disabled={submitting || url.trim().length === 0}
          style={[
            styles.primaryButton,
            (submitting || url.trim().length === 0) && { opacity: 0.4 },
          ]}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonLabel}>Add to Storage</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { padding: 16, gap: 12 },
  title: { color: '#e8f1ff', fontSize: 18, fontWeight: '600' },
  hint: { color: '#7aa3d4', fontSize: 13, lineHeight: 18 },
  input: {
    color: '#e8f1ff',
    fontSize: 15,
    backgroundColor: '#11203a',
    borderRadius: 8,
    padding: 12,
  },
  primaryButton: {
    backgroundColor: '#4d8fdb',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 6,
    alignSelf: 'flex-start',
    minWidth: 160,
    alignItems: 'center',
  },
  primaryButtonLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  errorText: { color: '#f87171', fontSize: 12 },
});
