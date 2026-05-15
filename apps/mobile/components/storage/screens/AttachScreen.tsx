// Wiki page picker for "Add to Notes". User picks a target page;
// server enqueues ingestion subtree-scoped to that page. After
// success, navigates back to the Detail screen which re-fetches to
// show the new attachment row.
//
// Search filters by title or slug — fuzzy contains-match (case-
// insensitive). For v0.3.0 we show all user-scope pages; later
// passes can fold in "recent" / "your projects" sections.

import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useWikiPages } from '../../../lib/rxdb/useWikiPages';
import { ingestUpload, ingestUrlSource } from '../../../lib/storage/api';
import { PluginBackRow } from '../../PluginStack';
import type { StorageStackParamList } from '../StorageNavigation';

export function AttachScreen({
  navigation,
  route,
}: NativeStackScreenProps<StorageStackParamList, 'Attach'>) {
  const { family, itemId } = route.params;
  const pages = useWikiPages();
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return pages;
    return pages.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q),
    );
  }, [pages, query]);

  async function attach(pageId: string) {
    setSubmitting(pageId);
    try {
      if (family === 'upload') {
        await ingestUpload({ uploadId: itemId, attachToPageId: pageId });
      } else {
        await ingestUrlSource({ urlSourceId: itemId, attachToPageId: pageId });
      }
      navigation.goBack();
    } catch (e) {
      Alert.alert('Couldn’t attach', e instanceof Error ? e.message : String(e));
      setSubmitting(null);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <PluginBackRow label="Detail" onPress={() => navigation.goBack()} />
      <View style={styles.headerBlock}>
        <Text style={styles.title}>Attach to which page?</Text>
        <Text style={styles.hint}>
          Ingestion writes only inside this page's subtree — pick the project, profile area,
          or braindump cluster this belongs to.
        </Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search pages…"
          placeholderTextColor="#3f5a83"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No pages match "{query}". Try a project, profile area, or braindump cluster name.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const isSubmitting = submitting === item.id;
          return (
            <Pressable
              style={[styles.row, isSubmitting && { opacity: 0.4 }]}
              disabled={!!submitting}
              onPress={() => void attach(item.id)}
            >
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.rowSlug} numberOfLines={1}>
                  {item.slug}
                </Text>
              </View>
              {isSubmitting ? (
                <ActivityIndicator size="small" color="#4d8fdb" />
              ) : (
                <Ionicons name="add-circle-outline" size={20} color="#4d8fdb" />
              )}
            </Pressable>
          );
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerBlock: {
    padding: 16,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
  },
  title: { color: '#e8f1ff', fontSize: 18, fontWeight: '600' },
  hint: { color: '#7aa3d4', fontSize: 13, lineHeight: 18 },
  input: {
    color: '#e8f1ff',
    fontSize: 15,
    backgroundColor: '#11203a',
    borderRadius: 8,
    padding: 10,
  },
  list: { paddingVertical: 4 },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: '#7aa3d4', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  rowMain: { flex: 1, gap: 2 },
  rowTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '500' },
  rowSlug: { color: '#7aa3d4', fontSize: 11, fontFamily: 'Menlo' },
});
