// Wiki plugin's stack navigation — folder-tree model.
//
// Every page is both content (sections) AND a folder (potentially with
// children). Navigation walks parent_page_id chains rather than grouping by
// type. Top-level (Folders) lists pages where parent_page_id IS NULL, plus a
// search input that filters across the whole tree. Each Page screen renders:
// breadcrumbs at top → title + abstract + sections → sub-pages list at bottom.
//
// The previous model (group by type, special-case todo buckets) is gone —
// type is now metadata only, used for icons and badges. The flat type list
// hid the semantic hierarchy Pro produces (e.g. profile/relationships/sarah
// got rendered as a sibling of profile under "People", flattening structure).
// See specs/fan-out-prompt.md §4.3 for the structural rules Pro follows.

import { Ionicons } from '@expo/vector-icons';
import {
  type NativeStackScreenProps,
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import type { WikiPageDoc, WikiSectionDoc } from '../../lib/rxdb/schemas';
import { useRxdbReady } from '../../lib/rxdb/useRxdbReady';
import { useWikiPages, useWikiSectionsForPage } from '../../lib/rxdb/useWikiPages';
import { pluginStackScreenOptions } from '../PluginStack';
import { WikiSectionEditor } from '../WikiSectionEditor';
import { Breadcrumbs } from './Breadcrumbs';
import {
  countChildren,
  getAncestorChain,
  getChildren,
  getTopLevelPages,
  searchPages,
  type WikiSearchHit,
} from './tree';

const TYPE_ICONS: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
  person: 'people-outline',
  concept: 'bulb-outline',
  project: 'briefcase-outline',
  place: 'location-outline',
  org: 'business-outline',
  source: 'document-text-outline',
  event: 'calendar-outline',
  note: 'create-outline',
  profile: 'person-circle-outline',
  todo: 'checkbox-outline',
};

function iconFor(type: string): React.ComponentProps<typeof Ionicons>['name'] {
  return TYPE_ICONS[type] ?? 'document-outline';
}

export type WikiStackParamList = {
  Folders: undefined;
  Page: { pageId: string };
};

const Stack = createNativeStackNavigator<WikiStackParamList>();

export function WikiStack() {
  return (
    <Stack.Navigator
      screenOptions={pluginStackScreenOptions}
      initialRouteName="Folders"
    >
      <Stack.Screen name="Folders" component={FoldersScreen} />
      <Stack.Screen name="Page" component={PageScreen} />
    </Stack.Navigator>
  );
}

// ── Folders (top-level + search) ──────────────────────────────────────────

function FoldersScreen({
  navigation,
}: NativeStackScreenProps<WikiStackParamList, 'Folders'>) {
  const ready = useRxdbReady();
  const pages = useWikiPages();
  const [query, setQuery] = useState('');

  const topLevel = useMemo(() => getTopLevelPages(pages), [pages]);
  const childCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pages) m.set(p.id, countChildren(p.id, pages));
    return m;
  }, [pages]);
  const searchResults = useMemo(() => searchPages(query, pages), [query, pages]);
  const searching = query.trim().length > 0;

  if (!ready) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Syncing your wiki…</Text>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <View style={styles.searchBar}>
        <Ionicons name="search-outline" size={16} color="#7aa3d4" />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search your wiki"
          placeholderTextColor="#3f5a83"
          style={styles.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {searching && (
          <Pressable onPress={() => setQuery('')} hitSlop={12}>
            <Ionicons name="close-circle" size={18} color="#3f5a83" />
          </Pressable>
        )}
      </View>

      {searching ? (
        <SearchResultsList
          hits={searchResults}
          onPick={(pageId) => navigation.push('Page', { pageId })}
        />
      ) : (
        <FlatList
          data={topLevel}
          keyExtractor={(p) => p.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                No pages yet. Have a call with Audri and your wiki will start to populate.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <PageRow
              page={item}
              childCount={childCounts.get(item.id) ?? 0}
              onPress={() => navigation.push('Page', { pageId: item.id })}
            />
          )}
        />
      )}
    </View>
  );
}

function SearchResultsList({
  hits,
  onPick,
}: {
  hits: WikiSearchHit[];
  onPick: (pageId: string) => void;
}) {
  return (
    <FlatList
      data={hits}
      keyExtractor={(h) => h.page.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No matches.</Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          style={styles.searchRow}
          onPress={() => onPick(item.page.id)}
        >
          <View style={styles.rowIcon}>
            <Ionicons name={iconFor(item.page.type)} size={18} color="#7aa3d4" />
          </View>
          <View style={styles.searchRowMain}>
            <Text style={styles.pageRowTitle} numberOfLines={1}>
              {item.page.title}
            </Text>
            {item.ancestors.length > 0 && (
              <Text style={styles.searchRowPath} numberOfLines={1}>
                {item.ancestors.map((a) => a.title).join(' › ')}
              </Text>
            )}
            {item.page.agent_abstract && (
              <Text style={styles.pageRowAbstract} numberOfLines={2}>
                {item.page.agent_abstract}
              </Text>
            )}
          </View>
          <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
        </Pressable>
      )}
    />
  );
}

// ── Page (universal page view) ────────────────────────────────────────────

function PageScreen({
  navigation,
  route,
}: NativeStackScreenProps<WikiStackParamList, 'Page'>) {
  const pages = useWikiPages();
  const page = useMemo(
    () => pages.find((p) => p.id === route.params.pageId),
    [pages, route.params.pageId],
  );
  const sections = useWikiSectionsForPage(page?.id ?? null);
  const children = useMemo(
    () => (page ? getChildren(page.id, pages) : []),
    [page, pages],
  );
  const childCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of children) m.set(c.id, countChildren(c.id, pages));
    return m;
  }, [children, pages]);
  const ancestors = useMemo(
    () => (page ? getAncestorChain(page.id, pages).slice(0, -1) : []),
    [page, pages],
  );
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);

  const goToAncestor = (pageId: string | null) => {
    if (pageId === null) {
      navigation.popToTop();
    } else {
      navigation.push('Page', { pageId });
    }
  };

  if (!page) {
    return (
      <View style={styles.flex}>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Page not found.</Text>
        </View>
      </View>
    );
  }

  if (editingSectionId) {
    const section = sections.find((s) => s.id === editingSectionId);
    if (section) {
      return (
        <WikiSectionEditor
          section={section}
          onClose={() => setEditingSectionId(null)}
        />
      );
    }
  }

  return (
    <View style={styles.flex}>
      <Breadcrumbs ancestors={ancestors} onSegmentPress={goToAncestor} />
      <ScrollView contentContainerStyle={styles.pageScroll}>
        <View style={styles.pageHeader}>
          <Ionicons name={iconFor(page.type)} size={20} color="#7aa3d4" />
          <Text style={styles.pageTitle}>{page.title}</Text>
        </View>
        {page.abstract && <Text style={styles.pageAbstract}>{page.abstract}</Text>}

        <SectionsView
          sections={sections}
          onEditSection={(id) => setEditingSectionId(id)}
        />

        {children.length > 0 && (
          <SubPagesList
            children={children}
            childCounts={childCounts}
            onPress={(id) => navigation.push('Page', { pageId: id })}
          />
        )}
      </ScrollView>
    </View>
  );
}

function SectionsView({
  sections,
  onEditSection,
}: {
  sections: WikiSectionDoc[];
  onEditSection: (id: string) => void;
}) {
  if (sections.length === 0) return null;
  return (
    <View style={styles.sectionsBlock}>
      {sections.map((s) => (
        <Pressable
          key={s.id}
          style={styles.section}
          onPress={() => onEditSection(s.id)}
        >
          {s.title && <Text style={styles.sectionTitle}>{s.title}</Text>}
          <Markdown style={markdownStyles}>{s.content}</Markdown>
          <View style={styles.editHint}>
            <Ionicons name="create-outline" size={14} color="#3f5a83" />
            <Text style={styles.editHintText}>tap to edit</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function SubPagesList({
  children,
  childCounts,
  onPress,
}: {
  children: WikiPageDoc[];
  childCounts: Map<string, number>;
  onPress: (id: string) => void;
}) {
  return (
    <View style={styles.subPagesBlock}>
      <Text style={styles.subPagesHeader}>
        Sub-pages
      </Text>
      {children.map((c) => (
        <PageRow
          key={c.id}
          page={c}
          childCount={childCounts.get(c.id) ?? 0}
          onPress={() => onPress(c.id)}
        />
      ))}
    </View>
  );
}

// ── Shared row component ──────────────────────────────────────────────────

function PageRow({
  page,
  childCount,
  onPress,
}: {
  page: WikiPageDoc;
  childCount: number;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowIcon}>
        <Ionicons name={iconFor(page.type)} size={20} color="#7aa3d4" />
      </View>
      <View style={styles.rowMain}>
        <Text style={styles.pageRowTitle} numberOfLines={1}>
          {page.title}
        </Text>
        {page.agent_abstract && (
          <Text style={styles.pageRowAbstract} numberOfLines={2}>
            {page.agent_abstract}
          </Text>
        )}
      </View>
      {childCount > 0 && <Text style={styles.rowCount}>{childCount}</Text>}
      <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
    </Pressable>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#7aa3d4' },
  list: { paddingVertical: 8 },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: '#7aa3d4', fontSize: 14, textAlign: 'center' },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#11203a',
    borderRadius: 10,
  },
  searchInput: {
    flex: 1,
    color: '#e8f1ff',
    fontSize: 14,
    paddingVertical: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#11203a',
  },
  rowMain: { flex: 1, gap: 2 },
  rowCount: { color: '#7aa3d4', fontSize: 13 },
  pageRowTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '500' },
  pageRowAbstract: { color: '#7aa3d4', fontSize: 13, lineHeight: 17 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  searchRowMain: { flex: 1, gap: 4 },
  searchRowPath: {
    color: '#3f5a83',
    fontSize: 11,
    letterSpacing: 0.3,
  },
  pageScroll: { paddingHorizontal: 20, paddingBottom: 40, gap: 16 },
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  pageTitle: {
    flex: 1,
    color: '#e8f1ff',
    fontSize: 24,
    fontWeight: '600',
  },
  pageAbstract: { color: '#cbd9eb', fontSize: 15, lineHeight: 22 },
  sectionsBlock: { gap: 12 },
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
  subPagesBlock: {
    marginTop: 8,
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: '#1f2f4d',
    paddingTop: 16,
  },
  subPagesHeader: {
    color: '#7aa3d4',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    marginBottom: 4,
  },
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
