// Storage list — "Recently Added". Combined feed of uploads + URL
// sources, sorted by created_at desc. Tap a row to open the detail
// screen; tap "+" to add (file picker or URL paste).
//
// v0.3.0 scope: flat chronological list. Filesystem-style folder
// navigation is a follow-up pass (see backlog).

import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { type StorageItem, useStorageItems } from '../../../lib/storage/useStorage';
import { ITEM_KIND_ICON, type StorageStackParamList } from '../StorageNavigation';

export function ListScreen({
  navigation,
}: NativeStackScreenProps<StorageStackParamList, 'List'>) {
  const { data, loading, error, refresh } = useStorageItems();

  if (loading && !data) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#4d8fdb" />
      </View>
    );
  }

  if (error && !data) {
    return (
      <View style={styles.empty}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable onPress={() => void refresh()} style={styles.retryButton}>
          <Text style={styles.retryButtonLabel}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <Pressable style={styles.addRow} onPress={() => navigation.push('AddPicker')}>
        <Ionicons name="add-circle-outline" size={22} color="#4d8fdb" />
        <Text style={styles.addRowLabel}>Add to Storage</Text>
      </Pressable>
      <FlatList
        data={data ?? []}
        keyExtractor={(item) => `${item.family}:${item.id}`}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No items yet. Tap "Add to Storage" to upload a file or paste a URL.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() =>
              navigation.push('Detail', { family: item.family, itemId: item.id })
            }
          >
            <View style={styles.iconBox}>
              <Ionicons name={ITEM_KIND_ICON[item.kind]} size={20} color="#7aa3d4" />
            </View>
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle} numberOfLines={2}>
                {itemTitle(item)}
              </Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {itemSubtitle(item)}
              </Text>
              <Text style={styles.rowStatus} numberOfLines={1}>
                {statusLabel(item)}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
          </Pressable>
        )}
      />
    </View>
  );
}

function itemTitle(item: StorageItem): string {
  if (item.family === 'upload') return item.original_filename;
  return item.title || item.url;
}

function itemSubtitle(item: StorageItem): string {
  if (item.family === 'upload') {
    const kb = (item.size_bytes / 1024).toFixed(0);
    return `${item.kind.toUpperCase()} · ${kb} KB`;
  }
  return item.site_name || hostFromUrl(item.url);
}

function statusLabel(item: StorageItem): string {
  const attached = item.attachments.some((a) => a.status === 'succeeded');
  if (attached) {
    const pages = item.attachments
      .filter((a) => a.status === 'succeeded')
      .map((a) => a.page_slug || a.page_id)
      .slice(0, 2)
      .join(', ');
    const more = item.attachments.length > 2 ? '…' : '';
    return `Attached: ${pages}${more}`;
  }
  return extractionLabel(item);
}

function extractionLabel(item: StorageItem): string {
  switch (item.extraction_status) {
    case 'awaiting_upload':
      return 'Awaiting upload';
    case 'pending':
      return 'Queued';
    case 'running':
      return item.family === 'upload' ? 'Extracting…' : 'Fetching…';
    case 'succeeded':
      return 'Ready to attach';
    case 'failed':
      return item.extraction_error
        ? `Failed: ${item.extraction_error.slice(0, 60)}`
        : 'Failed';
    default:
      return '';
  }
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { padding: 24, alignItems: 'center', gap: 12 },
  emptyText: { color: '#7aa3d4', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  errorText: { color: '#f87171', fontSize: 13, textAlign: 'center' },
  retryButton: {
    backgroundColor: '#11203a',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  retryButtonLabel: { color: '#e8f1ff', fontSize: 13 },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
  },
  addRowLabel: { color: '#4d8fdb', fontSize: 15, fontWeight: '500' },
  list: { paddingVertical: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#11203a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMain: { flex: 1, gap: 3 },
  rowTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '600' },
  rowMeta: { color: '#7aa3d4', fontSize: 12, lineHeight: 16 },
  rowStatus: { color: '#4d8fdb', fontSize: 12, lineHeight: 16, marginTop: 2 },
});
