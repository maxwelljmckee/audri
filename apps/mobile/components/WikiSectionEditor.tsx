import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { getDatabase } from '../lib/rxdb/database';
import type { WikiSectionDoc } from '../lib/rxdb/schemas';
import { captureClientError } from '../lib/sentry';

interface Props {
  section: WikiSectionDoc;
  onClose: () => void;
}

// Basic raw-markdown editor. WYSIWYG comes V1+. The TextInput holds raw
// markdown; the user sees rendered output back when they navigate to the
// page detail view after save.
export function WikiSectionEditor({ section, onClose }: Props) {
  const [title, setTitle] = useState(section.title ?? '');
  const [content, setContent] = useState(section.content);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const db = await getDatabase();
      const doc = await db.collections.wiki_sections.findOne(section.id).exec();
      if (doc) {
        await doc.patch({
          title: title.trim() || null,
          content,
          updated_at: new Date().toISOString(),
        });
      }
      onClose();
    } catch (err) {
      captureClientError('wiki-editor-save', err, { sectionId: section.id });
      setSaving(false);
    }
  }

  const dirty = title !== (section.title ?? '') || content !== section.content;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={20}
    >
      <View style={styles.headerRow}>
        <Pressable onPress={onClose} hitSlop={12}>
          <Ionicons name="close" size={22} color="#7aa3d4" />
        </Pressable>
        <Text style={styles.headerTitle}>Edit section</Text>
        <Pressable
          onPress={save}
          disabled={!dirty || saving}
          style={[styles.saveButton, (!dirty || saving) && { opacity: 0.4 }]}
        >
          <Text style={styles.saveLabel}>{saving ? 'Saving…' : 'Save'}</Text>
        </Pressable>
      </View>

      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="Section title (optional)"
        placeholderTextColor="#3f5a83"
        style={styles.titleInput}
      />

      <TextInput
        value={content}
        onChangeText={setContent}
        multiline
        style={styles.contentInput}
        placeholder="Markdown content…"
        placeholderTextColor="#3f5a83"
        autoCorrect
        autoCapitalize="sentences"
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#0a1628' },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
    gap: 12,
  },
  headerTitle: {
    flex: 1,
    color: '#e8f1ff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  saveButton: {
    backgroundColor: '#4d8fdb',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  saveLabel: { color: '#fff', fontSize: 13, fontWeight: '500' },
  titleInput: {
    color: '#e8f1ff',
    fontSize: 17,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
  },
  contentInput: {
    flex: 1,
    color: '#cbd9eb',
    fontSize: 15,
    lineHeight: 22,
    paddingHorizontal: 16,
    paddingVertical: 12,
    textAlignVertical: 'top',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
