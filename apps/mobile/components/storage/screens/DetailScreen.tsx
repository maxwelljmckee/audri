// Storage detail screen — shows extracted_text preview, metadata, and
// the list of attachments. Two primary actions:
//   - "Add to Notes" → routes to Attach screen (page picker)
//   - "Delete" → confirmation alert → tombstone
//
// For uploads, also shows a "Download original" affordance using the
// short-lived signed URL the server hands back on detail fetch.

import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  type UploadDetail,
  type UrlSourceDetail,
  deleteUpload,
  deleteUrlSource,
  getUpload,
  getUrlSource,
} from '../../../lib/storage/api';
import { PluginBackRow } from '../../PluginStack';
import { ITEM_KIND_ICON, type StorageStackParamList } from '../StorageNavigation';

type Detail =
  | ({ family: 'upload' } & UploadDetail)
  | ({ family: 'url_source' } & UrlSourceDetail);

export function DetailScreen({
  navigation,
  route,
}: NativeStackScreenProps<StorageStackParamList, 'Detail'>) {
  const { family, itemId } = route.params;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (family === 'upload') {
        const row = await getUpload(itemId);
        setDetail({ family: 'upload', ...row });
      } else {
        const row = await getUrlSource(itemId);
        setDetail({ family: 'url_source', ...row });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [family, itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onDelete = useCallback(() => {
    if (!detail) return;
    Alert.alert(
      'Delete this item?',
      family === 'upload'
        ? 'The file will be removed from Storage. Any wiki content already produced stays.'
        : 'The URL will be removed from Storage. Any wiki content already produced stays.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              if (family === 'upload') await deleteUpload(itemId);
              else await deleteUrlSource(itemId);
              navigation.goBack();
            } catch (e) {
              Alert.alert('Couldn’t delete', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  }, [detail, family, itemId, navigation]);

  if (loading && !detail) {
    return (
      <View style={styles.flex}>
        <PluginBackRow label="Storage" onPress={() => navigation.goBack()} />
        <View style={styles.loading}>
          <ActivityIndicator color="#4d8fdb" />
        </View>
      </View>
    );
  }

  if (error || !detail) {
    return (
      <View style={styles.flex}>
        <PluginBackRow label="Storage" onPress={() => navigation.goBack()} />
        <View style={styles.empty}>
          <Text style={styles.errorText}>{error ?? 'Item not found.'}</Text>
        </View>
      </View>
    );
  }

  const succeededAttachments = detail.attachments.filter((a) => a.status === 'succeeded');
  const inFlightAttachments = detail.attachments.filter(
    (a) => a.status === 'pending' || a.status === 'running',
  );
  const failedAttachments = detail.attachments.filter((a) => a.status === 'failed');

  const canAttach = detail.extraction_status === 'succeeded';

  return (
    <View style={styles.flex}>
      <PluginBackRow label="Storage" onPress={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.headerRow}>
          <View style={styles.iconBox}>
            <Ionicons name={ITEM_KIND_ICON[detail.kind]} size={22} color="#7aa3d4" />
          </View>
          <View style={styles.headerMain}>
            <Text style={styles.title}>{titleOf(detail)}</Text>
            <Text style={styles.subtitle}>{subtitleOf(detail)}</Text>
          </View>
        </View>

        <Text style={styles.statusLine}>{extractionStatusLine(detail)}</Text>

        {detail.family === 'upload' && detail.download_url && (
          <Pressable
            style={styles.secondaryButton}
            onPress={() => detail.download_url && Linking.openURL(detail.download_url)}
          >
            <Ionicons name="download-outline" size={16} color="#e8f1ff" />
            <Text style={styles.secondaryButtonLabel}>Download original</Text>
          </Pressable>
        )}
        {detail.family === 'url_source' && (
          <Pressable
            style={styles.secondaryButton}
            onPress={() => Linking.openURL(detail.fetched_url ?? detail.url)}
          >
            <Ionicons name="open-outline" size={16} color="#e8f1ff" />
            <Text style={styles.secondaryButtonLabel}>Open original URL</Text>
          </Pressable>
        )}

        {/* ── Attachments ────────────────────────────────────────── */}
        <Text style={styles.sectionHeader}>Attached to Notes</Text>
        {detail.attachments.length === 0 ? (
          <Text style={styles.hint}>
            Not yet attached. Add to Notes to fold this into your wiki.
          </Text>
        ) : (
          <View style={styles.attachmentList}>
            {succeededAttachments.map((a) => (
              <View key={a.id} style={[styles.attachmentRow, styles.attachmentSucceeded]}>
                <Ionicons name="checkmark-circle" size={16} color="#34d399" />
                <Text style={styles.attachmentText}>{a.page_slug || a.page_id}</Text>
              </View>
            ))}
            {inFlightAttachments.map((a) => (
              <View key={a.id} style={[styles.attachmentRow, styles.attachmentInFlight]}>
                <ActivityIndicator size="small" color="#4d8fdb" />
                <Text style={styles.attachmentText}>
                  {a.status === 'running' ? 'Ingesting' : 'Queued'}: {a.page_slug || a.page_id}
                </Text>
              </View>
            ))}
            {failedAttachments.map((a) => (
              <View key={a.id} style={[styles.attachmentRow, styles.attachmentFailed]}>
                <Ionicons name="alert-circle" size={16} color="#f87171" />
                <View style={styles.flex}>
                  <Text style={styles.attachmentText}>{a.page_slug || a.page_id}</Text>
                  {a.error && (
                    <Text style={styles.attachmentError} numberOfLines={3}>
                      {a.error}
                    </Text>
                  )}
                </View>
              </View>
            ))}
          </View>
        )}

        <Pressable
          style={[styles.primaryButton, !canAttach && { opacity: 0.4 }]}
          disabled={!canAttach}
          onPress={() => navigation.push('Attach', { family, itemId })}
        >
          <Ionicons name="add-outline" size={18} color="#fff" />
          <Text style={styles.primaryButtonLabel}>Add to Notes</Text>
        </Pressable>

        {/* ── Extracted text preview ─────────────────────────────── */}
        {detail.extracted_text && (
          <>
            <Text style={styles.sectionHeader}>Extracted text</Text>
            <View style={styles.textBox}>
              <Text style={styles.extractedText} selectable>
                {detail.extracted_text.length > 8000
                  ? `${detail.extracted_text.slice(0, 8000)}\n\n[truncated — ${detail.extracted_text.length} total chars]`
                  : detail.extracted_text}
              </Text>
            </View>
          </>
        )}

        <Pressable style={styles.destructiveButton} onPress={onDelete}>
          <Text style={styles.destructiveButtonLabel}>Delete</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function titleOf(detail: Detail): string {
  if (detail.family === 'upload') return detail.original_filename;
  return detail.title || detail.url;
}

function subtitleOf(detail: Detail): string {
  if (detail.family === 'upload') {
    const kb = (detail.size_bytes / 1024).toFixed(0);
    return `${detail.kind.toUpperCase()} · ${kb} KB`;
  }
  return detail.site_name || hostFromUrl(detail.url);
}

function extractionStatusLine(detail: Detail): string {
  switch (detail.extraction_status) {
    case 'awaiting_upload':
      return 'Awaiting upload';
    case 'pending':
      return 'Queued for extraction';
    case 'running':
      return detail.family === 'upload' ? 'Extracting text…' : 'Fetching + extracting…';
    case 'succeeded':
      return 'Ready to attach to Notes';
    case 'failed':
      return detail.extraction_error ? `Extraction failed: ${detail.extraction_error}` : 'Extraction failed';
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
  empty: { padding: 24, alignItems: 'center' },
  errorText: { color: '#f87171', fontSize: 13 },
  body: { padding: 16, paddingBottom: 40, gap: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBox: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#11203a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerMain: { flex: 1, gap: 2 },
  title: { color: '#e8f1ff', fontSize: 18, fontWeight: '700' },
  subtitle: { color: '#7aa3d4', fontSize: 13 },
  statusLine: { color: '#4d8fdb', fontSize: 13, marginTop: 4 },
  hint: { color: '#7aa3d4', fontSize: 13, lineHeight: 18, fontStyle: 'italic' },
  sectionHeader: {
    color: '#e8f1ff',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 18,
    marginBottom: 4,
  },
  attachmentList: { gap: 6 },
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 6,
  },
  attachmentSucceeded: { backgroundColor: '#0f1f1c' },
  attachmentInFlight: { backgroundColor: '#0e1c30' },
  attachmentFailed: { backgroundColor: '#1a0e12' },
  attachmentText: { color: '#e8f1ff', fontSize: 13 },
  attachmentError: { color: '#f87171', fontSize: 11, marginTop: 2 },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#4d8fdb',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 6,
    marginTop: 12,
  },
  primaryButtonLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#11203a',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 6,
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  secondaryButtonLabel: { color: '#e8f1ff', fontSize: 13 },
  textBox: {
    backgroundColor: '#0e1c30',
    borderRadius: 6,
    padding: 12,
    marginTop: 4,
  },
  extractedText: { color: '#d4dfee', fontSize: 13, lineHeight: 19 },
  destructiveButton: {
    backgroundColor: '#0e1c30',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#7a2233',
    alignItems: 'center',
    marginTop: 32,
  },
  destructiveButtonLabel: { color: '#f87171', fontSize: 14, fontWeight: '600' },
});
