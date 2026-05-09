import { Ionicons } from '@expo/vector-icons';
import { useRef } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import type { ResearchFindingDoc, ResearchOutputDoc } from '../lib/rxdb/schemas';

interface Props {
  output: ResearchOutputDoc;
  onBack: () => void;
}

// Hostname display: strips protocol + leading 'www.', falls back to the raw
// URL if it doesn't parse as a valid URL.
function hostnameFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function ResearchOutputDetail({ output, onBack }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  // 1-indexed citation cards keyed by citation number.
  const citationRefs = useRef<Map<number, View>>(new Map());

  // Tap [N] in a finding's source line → scroll to the matching citation
  // card. The card itself opens the external URL when tapped (one indirection
  // step keeps the in-document jump distinct from leaving the app).
  const scrollToCitation = (idx1: number) => {
    const node = citationRefs.current.get(idx1);
    const scroll = scrollRef.current;
    if (!node || !scroll) return;
    node.measureLayout(
      // @ts-expect-error react-native ScrollView measureLayout target type
      scroll,
      (_x, y) => {
        scroll.scrollTo({ y: Math.max(0, y - 12), animated: true });
      },
      () => {},
    );
  };

  return (
    <View style={styles.flex}>
      <Pressable style={styles.backRow} onPress={onBack}>
        <Ionicons name="chevron-back" size={20} color="#7aa3d4" />
        <Text style={styles.backLabel}>Research</Text>
      </Pressable>

      <ScrollView ref={scrollRef} contentContainerStyle={styles.body}>
        <Text style={styles.title}>{output.title || output.query}</Text>
        <Text style={styles.queryLine}>{output.query}</Text>
        <Text style={styles.timestamp}>{new Date(output.generated_at).toLocaleString()}</Text>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Summary</Text>
          <Text style={styles.summary}>{output.summary}</Text>
        </View>

        {output.findings.map((f: ResearchFindingDoc) => {
          const validCitations = f.citation_indices.filter(
            (i) => i > 0 && i <= output.citations.length,
          );
          return (
            <View key={f.heading} style={styles.finding}>
              <Text style={styles.findingHeading}>{f.heading}</Text>
              <Markdown style={markdownStyles}>{f.content}</Markdown>
              {validCitations.length > 0 && (
                <View style={styles.citationLine}>
                  <Text style={styles.citationLineLabel}>Sources: </Text>
                  {validCitations.map((i, k) => (
                    <Text
                      key={`${f.heading}-cite-${i}`}
                      style={styles.citationLink}
                      onPress={() => scrollToCitation(i)}
                    >
                      [{i}]{k < validCitations.length - 1 ? ' ' : ''}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          );
        })}

        {output.notes_for_user && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Notes</Text>
            <Text style={styles.notes}>{output.notes_for_user}</Text>
          </View>
        )}

        {output.follow_up_questions.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Follow-up questions</Text>
            {output.follow_up_questions.map((q) => (
              <Text key={q} style={styles.followUp}>
                – {q}
              </Text>
            ))}
          </View>
        )}

        {output.citations.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Citations</Text>
            {output.citations.map((c, i) => {
              const idx1 = i + 1;
              return (
                <View
                  key={c.url}
                  ref={(node) => {
                    if (node) citationRefs.current.set(idx1, node);
                    else citationRefs.current.delete(idx1);
                  }}
                  collapsable={false}
                >
                  <Pressable
                    style={styles.citation}
                    onPress={() => {
                      // Always navigate using the full URL — the displayed
                      // hostname is just a UX simplification.
                      void Linking.openURL(c.url);
                    }}
                  >
                    <Text style={styles.citationIndex}>[{idx1}]</Text>
                    <View style={styles.citationBody}>
                      <Text style={styles.citationTitle} numberOfLines={2}>
                        {c.title || hostnameFor(c.url)}
                      </Text>
                      {c.snippet ? (
                        <Text style={styles.citationSnippet} numberOfLines={3}>
                          {c.snippet}
                        </Text>
                      ) : null}
                      <Text style={styles.citationUrl} numberOfLines={1}>
                        {hostnameFor(c.url)}
                      </Text>
                    </View>
                  </Pressable>
                </View>
              );
            })}
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
  title: { color: '#e8f1ff', fontSize: 22, fontWeight: '600' },
  queryLine: { color: '#7aa3d4', fontSize: 13, lineHeight: 18, fontStyle: 'italic' },
  timestamp: { color: '#7aa3d4', fontSize: 12, marginTop: -8 },
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
  citationLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginTop: 4,
  },
  citationLineLabel: { color: '#7aa3d4', fontSize: 12 },
  citationLink: { color: '#4d8fdb', fontSize: 12, fontWeight: '500' },
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
