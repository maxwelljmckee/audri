// File-upload screen. Flow:
//   1. expo-document-picker launches iOS file picker on mount
//   2. User picks file → POST /uploads → returns signed upload URL
//   3. PUT file bytes to signed URL (direct to Supabase Storage)
//   4. POST /uploads/:id/finalize → enqueues extraction
//   5. Navigate back to List
//
// File picker auto-opens on mount; if user cancels, screen shows a
// retry button. Errors at any step show inline + leave a retry.

import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { finalizeUpload, initiateUpload } from '../../../lib/storage/api';
import { PluginBackRow } from '../../PluginStack';
import type { StorageStackParamList } from '../StorageNavigation';

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

type Stage = 'pick' | 'uploading' | 'finalizing' | 'done' | 'error' | 'cancelled';

export function AddFileScreen({
  navigation,
}: NativeStackScreenProps<StorageStackParamList, 'AddFile'>) {
  const [stage, setStage] = useState<Stage>('pick');
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runFlow = useCallback(async () => {
    setStage('pick');
    setError(null);
    setFilename(null);

    const picked = await DocumentPicker.getDocumentAsync({
      type: ALLOWED_MIME_TYPES,
      multiple: false,
      copyToCacheDirectory: true,
    });

    if (picked.canceled) {
      setStage('cancelled');
      return;
    }
    const asset = picked.assets[0];
    if (!asset) {
      setStage('error');
      setError('No file returned from picker');
      return;
    }

    setFilename(asset.name);
    setStage('uploading');

    try {
      // 1. Server inserts row + returns signed upload URL.
      const initResp = await initiateUpload({
        filename: asset.name,
        mimeType: asset.mimeType ?? 'application/octet-stream',
        sizeBytes: asset.size ?? 0,
      });

      // 2. PUT file bytes to the signed URL.
      const fileResp = await fetch(asset.uri);
      const blob = await fileResp.blob();
      const put = await fetch(initResp.upload_url, {
        method: 'PUT',
        headers: {
          'Content-Type': asset.mimeType ?? 'application/octet-stream',
        },
        body: blob,
      });
      if (!put.ok) {
        throw new Error(`Storage PUT failed: HTTP ${put.status}`);
      }

      // 3. Confirm to server; enqueues extraction.
      setStage('finalizing');
      await finalizeUpload(initResp.upload_id);

      setStage('done');
      // Brief pause for the user to read "Done" then navigate back.
      setTimeout(() => navigation.popToTop(), 400);
    } catch (e) {
      setStage('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [navigation]);

  useEffect(() => {
    void runFlow();
  }, [runFlow]);

  return (
    <View style={styles.flex}>
      <PluginBackRow label="Storage" onPress={() => navigation.goBack()} />
      <View style={styles.body}>
        {stage === 'pick' && (
          <View style={styles.stage}>
            <Text style={styles.title}>Opening file picker…</Text>
          </View>
        )}
        {stage === 'uploading' && (
          <View style={styles.stage}>
            <ActivityIndicator color="#4d8fdb" />
            <Text style={styles.title}>Uploading {filename}</Text>
            <Text style={styles.hint}>Sending the file to Storage…</Text>
          </View>
        )}
        {stage === 'finalizing' && (
          <View style={styles.stage}>
            <ActivityIndicator color="#4d8fdb" />
            <Text style={styles.title}>Finalizing…</Text>
            <Text style={styles.hint}>Extraction will start in the background.</Text>
          </View>
        )}
        {stage === 'done' && (
          <View style={styles.stage}>
            <Ionicons name="checkmark-circle-outline" size={40} color="#34d399" />
            <Text style={styles.title}>Added to Storage</Text>
          </View>
        )}
        {stage === 'cancelled' && (
          <View style={styles.stage}>
            <Text style={styles.title}>No file picked</Text>
            <Pressable style={styles.primaryButton} onPress={() => void runFlow()}>
              <Text style={styles.primaryButtonLabel}>Choose a file</Text>
            </Pressable>
          </View>
        )}
        {stage === 'error' && (
          <View style={styles.stage}>
            <Ionicons name="alert-circle-outline" size={32} color="#f87171" />
            <Text style={styles.title}>Upload failed</Text>
            {error && (
              <Text style={styles.errorText} numberOfLines={5}>
                {error}
              </Text>
            )}
            <Pressable style={styles.primaryButton} onPress={() => void runFlow()}>
              <Text style={styles.primaryButtonLabel}>Try again</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { flex: 1, padding: 16 },
  stage: { gap: 12, alignItems: 'center', paddingTop: 40 },
  title: { color: '#e8f1ff', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  hint: { color: '#7aa3d4', fontSize: 13, textAlign: 'center' },
  errorText: { color: '#f87171', fontSize: 12, textAlign: 'center' },
  primaryButton: {
    backgroundColor: '#4d8fdb',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 6,
    marginTop: 12,
  },
  primaryButtonLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
