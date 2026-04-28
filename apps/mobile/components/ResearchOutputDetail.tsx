import { Ionicons } from '@expo/vector-icons';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import type { ResearchFindingDoc, ResearchOutputDoc } from '../lib/rxdb/schemas';

interface Props {
  output: ResearchOutputDoc;
  onBack: () => void;
}

export function ResearchOutputDetail({ output, onBack }: Props) {
  const generatedDate = new Date(output.generated_at);

  return (
    <View style={styles.flex}>
      <Pressable style={styles.backRow} onPress={onBack}>
        <Ionicons name="chevron-back" size={20} color="#7aa3d4" />
        <Text style={styles.backLabel}>Research</Text>
      </Pressable>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.query}>{output.query}</Text>
        <Text style={styles.timestamp}>{generatedDate.toLocaleString()}</Text>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Summary</Text>
          <Text style={styles.summary}>{output.summary}</Text>
        </View>

        {output.findings.map((f: ResearchFindingDoc, idx) => (
          <View key={idx} style={styles.finding}>
            <Text style={styles.findingHeading}>{f.heading}</Text>
            <Markdown style={markdownStyles}>{f.content}</Markdown>
            {f.citation_indices.length > 0 && (
              <Text style={styles.citationLine}>
                Sources:{' '}
                {f.citation_indices
                  .filter((i) => i > 0 && i <= output.citations.length)
                  .map((i) => `[${i}]`)
                  .join(' ')}
              </Text>
            )}
          </View>
        ))}

        {output.notes_for_user && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Notes</Text>
            <Text style={styles.notes}>{output.notes_for_user}</Text>
          </View>
        )}

        {output.follow_up_questions.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Follow-up questions</Text>
            {output.follow_up_questions.map((q, i) => (
              <Text key={i} style={styles.followUp}>
                – {q}
              </Text>
            ))}
          </View>
        )}

        {output.citations.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Citations</Text>
            {output.citations.map((c, i) => (
              <Pressable
                key={i}
                style={styles.citation}
                onPress={() => {
                  void Linking.openURL(c.url);
                }}
              >
                <Text style={styles.citationIndex}>[{i + 1}]</Text>
                <View style={styles.citationBody}>
                  <Text style={styles.citationTitle} numberOfLines={2}>
                    {c.title || c.url}
                  </Text>
                  {c.snippet ? (
                    <Text style={styles.citationSnippet} numberOfLines={3}>
                      {c.snippet}
                    </Text>
                  ) : null}
                  <Text style={styles.citationUrl} numberOfLines={1}>
                    {c.url}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        )}
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
  body: { padding: 16, paddingBottom: 48, gap: 16 },
  query: { color: '#e8f1ff', fontSize: 22, fontWeight: '600' },
  timestamp: { color: '#7aa3d4', fontSize: 12 },
  section: { gap: 6 },
  sectionLabel: {
    color: '#7aa3d4',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  summary: { color: '#cbd9eb', fontSize: 15, lineHeight: 22 },
  notes: { color: '#cbd9eb', fontSize: 14, lineHeight: 20 },
  finding: { gap: 6 },
  findingHeading: { color: '#e8f1ff', fontSize: 17, fontWeight: '600' },
  citationLine: { color: '#7aa3d4', fontSize: 12, marginTop: 4 },
  followUp: { color: '#cbd9eb', fontSize: 14, lineHeight: 20 },
  citation: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#0e1a30',
    borderRadius: 8,
    marginTop: 8,
  },
  citationIndex: { color: '#7aa3d4', fontSize: 13, fontWeight: '600', width: 24 },
  citationBody: { flex: 1, gap: 4 },
  citationTitle: { color: '#e8f1ff', fontSize: 13, fontWeight: '500', lineHeight: 18 },
  citationSnippet: { color: '#cbd9eb', fontSize: 12, lineHeight: 17 },
  citationUrl: { color: '#4d8fdb', fontSize: 11 },
});

const markdownStyles = {
  body: { color: '#cbd9eb', fontSize: 15, lineHeight: 22 },
  paragraph: { marginVertical: 6 },
  strong: { color: '#e8f1ff', fontWeight: '600' as const },
  em: { fontStyle: 'italic' as const },
  bullet_list: { marginVertical: 6 },
  ordered_list: { marginVertical: 6 },
  link: { color: '#4d8fdb' },
  code_inline: {
    color: '#e8f1ff',
    backgroundColor: '#11203a',
    paddingHorizontal: 4,
    borderRadius: 3,
  },
};
