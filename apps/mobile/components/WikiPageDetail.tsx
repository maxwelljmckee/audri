import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import type { WikiPageDoc } from '../lib/rxdb/schemas';
import { useWikiSectionsForPage } from '../lib/rxdb/useWikiPages';
import { WikiSectionEditor } from './WikiSectionEditor';

interface Props {
  page: WikiPageDoc;
  onBack: () => void;
}

export function WikiPageDetail({ page, onBack }: Props) {
  const sections = useWikiSectionsForPage(page.id);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);

  if (editingSectionId) {
    const section = sections.find((s) => s.id === editingSectionId);
    if (section) {
      return <WikiSectionEditor section={section} onClose={() => setEditingSectionId(null)} />;
    }
  }

  return (
    <View style={styles.flex}>
      <Pressable style={styles.backRow} onPress={onBack}>
        <Ionicons name="chevron-back" size={20} color="#7aa3d4" />
        <Text style={styles.backLabel}>Back</Text>
      </Pressable>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>{page.title}</Text>
        <Text style={styles.typeTag}>{page.type}</Text>
        {page.abstract && <Text style={styles.abstract}>{page.abstract}</Text>}

        {sections.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No sections yet.</Text>
          </View>
        )}

        {sections.map((s) => (
          <Pressable key={s.id} style={styles.section} onPress={() => setEditingSectionId(s.id)}>
            {s.title && <Text style={styles.sectionTitle}>{s.title}</Text>}
            <Markdown style={markdownStyles}>{s.content}</Markdown>
            <View style={styles.editHint}>
              <Ionicons name="create-outline" size={14} color="#3f5a83" />
              <Text style={styles.editHintText}>tap to edit</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  backLabel: { color: '#7aa3d4', fontSize: 15 },
  scroll: { paddingHorizontal: 20, paddingBottom: 40, gap: 16 },
  title: { color: '#e8f1ff', fontSize: 24, fontWeight: '600', marginTop: 8 },
  typeTag: {
    alignSelf: 'flex-start',
    color: '#7aa3d4',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    backgroundColor: '#11203a',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: -8,
  },
  abstract: { color: '#cbd9eb', fontSize: 15, lineHeight: 22 },
  empty: { paddingVertical: 24, alignItems: 'center' },
  emptyText: { color: '#7aa3d4' },
  section: {
    backgroundColor: '#0f1d33',
    borderRadius: 12,
    padding: 16,
    gap: 6,
  },
  sectionTitle: {
    color: '#e8f1ff',
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 4,
  },
  editHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
    opacity: 0.6,
  },
  editHintText: { color: '#3f5a83', fontSize: 11 },
});

// biome-ignore lint/suspicious/noExplicitAny: react-native-markdown-display style typing is loose
const markdownStyles: any = {
  body: { color: '#cbd9eb', fontSize: 15, lineHeight: 22 },
  heading1: { color: '#e8f1ff', fontSize: 20, fontWeight: '600', marginTop: 8 },
  heading2: { color: '#e8f1ff', fontSize: 17, fontWeight: '600', marginTop: 8 },
  heading3: { color: '#e8f1ff', fontSize: 15, fontWeight: '600', marginTop: 6 },
  strong: { color: '#e8f1ff', fontWeight: '600' },
  em: { color: '#cbd9eb', fontStyle: 'italic' },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { color: '#cbd9eb' },
  paragraph: { marginVertical: 4, color: '#cbd9eb' },
  code_inline: {
    backgroundColor: '#1f2f4d',
    color: '#7aa3d4',
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  blockquote: {
    backgroundColor: '#11203a',
    borderLeftWidth: 3,
    borderLeftColor: '#4d8fdb',
    paddingLeft: 12,
    paddingVertical: 6,
  },
  link: { color: '#4d8fdb' },
};
