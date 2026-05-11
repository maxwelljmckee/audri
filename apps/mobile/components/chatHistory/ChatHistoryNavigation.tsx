// Chat History plugin's stack navigation. Two screens:
//
//   List   — chronological list of chats. Each row: kind avatar + agent
//             name + relative timestamp + ingestion-status badge.
//   Detail — iMessage-style turn rendering (readonly) + cross-references
//             panel showing notes-sections this chat produced.
//
// Schema-generalized for future text chats: rows render the kind avatar
// (mic for voice, message-circle for text) and the existing text-chat
// fallback path is in place. V1+ wiring (text chat creation) plugs in
// without further refactors here.

import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import {
  type NativeStackScreenProps,
  createNativeStackNavigator,
} from "@react-navigation/native-stack";
import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { CallTranscriptDoc, ChatTurn } from "../../lib/rxdb/schemas";
import { useReplicationResync } from "../../lib/rxdb/useReplicationResync";
import { useRxdbReady } from "../../lib/rxdb/useRxdbReady";
import {
  useCallTranscript,
  useCallTranscripts,
  useSectionsByTranscript,
} from "../../lib/rxdb/useCallTranscripts";
import { useWikiPages } from "../../lib/rxdb/useWikiPages";
import { useMe } from "../../lib/useMe";
import { useSession } from "../../lib/useSession";
import { PluginBackRow, pluginStackScreenOptions } from "../PluginStack";
import { ResyncControl } from "../ResyncControl";

export type ChatHistoryStackParamList = {
  List: undefined;
  Detail: { transcriptId: string };
};

const Stack = createNativeStackNavigator<ChatHistoryStackParamList>();

export function ChatHistoryStack() {
  return (
    <Stack.Navigator
      screenOptions={pluginStackScreenOptions}
      initialRouteName="List"
    >
      <Stack.Screen name="List" component={ListScreen} />
      <Stack.Screen name="Detail" component={DetailScreen} />
    </Stack.Navigator>
  );
}

// ── List screen ──────────────────────────────────────────────────────────────

function ListScreen({
  navigation,
}: NativeStackScreenProps<ChatHistoryStackParamList, "List">) {
  const ready = useRxdbReady();
  const transcripts = useCallTranscripts();
  const session = useSession();
  const accessToken =
    session.status === "signed-in" ? session.session.access_token : null;
  const me = useMe(accessToken);
  const { refreshing, onRefresh } = useReplicationResync();

  // Build agentId → agent name lookup so each row can show the agent that
  // hosted the chat. Agents come from /me, not RxDB.
  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    if (me.status === "ready") {
      for (const a of me.data.agents) m.set(a.id, a.name);
    }
    return m;
  }, [me]);

  // Group transcripts by calendar day. Assumes the underlying hook returns
  // newest-first; groups inherit that order naturally.
  const sections = useMemo(() => {
    const now = new Date();
    const groups = new Map<
      string,
      { title: string; data: CallTranscriptDoc[] }
    >();
    for (const t of transcripts) {
      const d = new Date(t.started_at);
      const key = d.toDateString();
      let group = groups.get(key);
      if (!group) {
        group = { title: formatSectionHeader(d, now), data: [] };
        groups.set(key, group);
      }
      group.data.push(t);
    }
    return Array.from(groups.values());
  }, [transcripts]);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Syncing your calls…</Text>
      </View>
    );
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={(t) => t.id}
      contentContainerStyle={styles.list}
      stickySectionHeadersEnabled={false}
      refreshControl={
        <ResyncControl refreshing={refreshing} onRefresh={onRefresh} />
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            No calls yet. After your first call with Audri, it'll show up here.
          </Text>
        </View>
      }
      renderSectionHeader={({ section }) => (
        <Text style={styles.sectionHeader}>{section.title}</Text>
      )}
      renderItem={({ item }) => (
        <ChatRow
          transcript={item}
          agentName={agentNameById.get(item.agent_id) ?? "Audri"}
          onPress={() => navigation.push("Detail", { transcriptId: item.id })}
        />
      )}
    />
  );
}

function ChatRow({
  transcript,
  agentName,
  onPress,
}: {
  transcript: CallTranscriptDoc;
  agentName: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.kindAvatar}>
        {transcript.kind === "text" ? (
          <MaterialCommunityIcons
            name="message-text-outline"
            size={20}
            color="#7aa3d4"
          />
        ) : (
          <Ionicons name="mic-outline" size={20} color="#7aa3d4" />
        )}
      </View>
      <View style={styles.rowMain}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowName} numberOfLines={1}>
            {agentName}
          </Text>
          <IngestionBadge status={transcript.ingestion_status} />
        </View>
        <Text style={styles.rowTimestamp}>
          {formatRowTime(transcript.started_at)}
        </Text>
        {transcript.title ? (
          <Text style={styles.rowTitle} numberOfLines={1}>
            {transcript.title}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
    </Pressable>
  );
}

function IngestionBadge({
  status,
}: {
  status: CallTranscriptDoc["ingestion_status"];
}) {
  if (status === "succeeded") return null;
  if (status === "failed") {
    return <Text style={[styles.badge, styles.badgeFailed]}>failed</Text>;
  }
  // pending or running — both indicate in-flight work
  return <Text style={[styles.badge, styles.badgePending]}>processing…</Text>;
}

// ── Detail screen ────────────────────────────────────────────────────────────

function DetailScreen({
  navigation,
  route,
}: NativeStackScreenProps<ChatHistoryStackParamList, "Detail">) {
  const transcript = useCallTranscript(route.params.transcriptId);
  const sectionLinks = useSectionsByTranscript(route.params.transcriptId);
  const wikiPages = useWikiPages();
  const session = useSession();
  const accessToken =
    session.status === "signed-in" ? session.session.access_token : null;
  const me = useMe(accessToken);

  const agentName = useMemo(() => {
    if (!transcript || me.status !== "ready") return "Audri";
    return (
      me.data.agents.find((a) => a.id === transcript.agent_id)?.name ?? "Audri"
    );
  }, [transcript, me]);

  // Resolve section links → page titles. Junction has section_id only;
  // we cross-reference wiki_sections via the page lookup we already have.
  const linkedPages = useMemo(() => {
    if (sectionLinks.length === 0) return [];
    const seenPageIds = new Set<string>();
    const out: { pageId: string; title: string }[] = [];
    for (const link of sectionLinks) {
      // Sections aren't directly indexed here; the simplest cross-ref is
      // "what wiki pages were involved." That's available by looking up
      // the section's page via wiki_pages... but wiki_sections isn't
      // resolved to page directly in this hook. Defer the precise section
      // resolution to V1+; show pages-touched count for now.
      // (Use sectionLinks.length as the sections-touched signal.)
      // No-op loop body to keep the structure for V1+ resolution.
      void seenPageIds;
      void link;
      void out;
    }
    return wikiPages.filter((p) => seenPageIds.has(p.id));
  }, [sectionLinks, wikiPages]);

  if (!transcript) {
    return (
      <View style={styles.flex}>
        <PluginBackRow
          label="Chat History"
          onPress={() => navigation.goBack()}
        />
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Call not found.</Text>
        </View>
      </View>
    );
  }

  const turns = (transcript.content ?? []) as ChatTurn[];

  return (
    <View style={styles.flex}>
      <PluginBackRow label="Chat History" onPress={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.detailScroll}>
        <View style={styles.detailHeader}>
          <View style={styles.kindAvatarLarge}>
            {transcript.kind === "text" ? (
              <MaterialCommunityIcons
                name="message-text-outline"
                size={28}
                color="#7aa3d4"
              />
            ) : (
              <Ionicons name="mic-outline" size={28} color="#7aa3d4" />
            )}
          </View>
          <Text style={styles.detailName}>{agentName}</Text>
          <Text style={styles.detailTimestamp}>
            {formatTimestamp(transcript.started_at)}
          </Text>
          {transcript.title ? (
            <Text style={styles.detailTitle}>{transcript.title}</Text>
          ) : null}
        </View>

        {sectionLinks.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>
              Notes touched ({sectionLinks.length})
            </Text>
            <Text style={styles.subtle}>
              This call contributed to {sectionLinks.length}{" "}
              {sectionLinks.length === 1 ? "note section" : "note sections"}.
              {linkedPages.length > 0
                ? ` Across ${linkedPages.length} pages.`
                : ""}
            </Text>
          </View>
        )}

        {transcript.ingestion_status !== "succeeded" && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Ingestion</Text>
            <IngestionStatus
              status={transcript.ingestion_status}
              error={transcript.ingestion_error}
            />
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Transcript</Text>
          {turns.length === 0 ? (
            <Text style={styles.subtle}>No transcript turns recorded.</Text>
          ) : (
            <View style={styles.turnsList}>
              {turns.map((turn, i) => (
                <TurnBubble
                  key={`${i}-${String(turn.role ?? "turn")}`}
                  turn={turn}
                />
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function TurnBubble({ turn }: { turn: ChatTurn }) {
  // Turn shape is permissive to accommodate evolving content schemas.
  // Treat anything keyed `role`/`from` as the speaker, `text`/`content`/
  // `transcript` as the body. Falls back to JSON-stringify if the shape
  // is unrecognized so debugging is possible.
  const role = String(turn.role ?? turn.from ?? "agent");
  const isUser = role === "user" || role === "human";
  const text = String(
    turn.text ?? turn.content ?? turn.transcript ?? JSON.stringify(turn),
  );

  return (
    <View
      style={[
        styles.turnRow,
        isUser ? styles.turnRowRight : styles.turnRowLeft,
      ]}
    >
      <View
        style={[
          styles.turnBubble,
          isUser ? styles.turnBubbleUser : styles.turnBubbleAgent,
        ]}
      >
        <Text
          style={[
            styles.turnText,
            isUser ? styles.turnTextUser : styles.turnTextAgent,
          ]}
        >
          {text}
        </Text>
      </View>
    </View>
  );
}

function IngestionStatus({
  status,
  error,
}: {
  status: CallTranscriptDoc["ingestion_status"];
  error: string | null;
}) {
  if (status === "pending" || status === "running") {
    return (
      <View style={styles.statusRow}>
        <ActivityIndicator color="#4d8fdb" size="small" />
        <Text style={styles.subtle}>
          Processing — new notes arrive in a moment.
        </Text>
      </View>
    );
  }
  if (status === "failed") {
    return (
      <View style={styles.statusRow}>
        <Ionicons name="alert-circle-outline" size={16} color="#f87171" />
        <Text style={[styles.subtle, { color: "#f87171" }]} numberOfLines={3}>
          Ingestion failed{error ? `: ${error}` : "."}
        </Text>
      </View>
    );
  }
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (sameDay) return `Today at ${time}`;
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  if (d.toDateString() === yesterday.toDateString())
    return `Yesterday at ${time}`;
  const dateStr = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
  return `${dateStr} at ${time}`;
}

function formatRowTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatSectionHeader(d: Date, now: Date): string {
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  const month = d.toLocaleDateString(undefined, { month: "long" });
  const day = d.getDate();
  const ord = ordinalSuffix(day);
  if (d.getFullYear() === now.getFullYear()) {
    return `${weekday}, ${month} ${day}${ord}`;
  }
  return `${weekday}, ${month} ${day}${ord}, ${d.getFullYear()}`;
}

function ordinalSuffix(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  loadingText: { color: "#7aa3d4" },
  empty: { padding: 24, alignItems: "center" },
  emptyText: {
    color: "#7aa3d4",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  list: { paddingVertical: 4 },
  sectionHeader: {
    color: "#7aa3d4",
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 6,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  kindAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#11203a",
    alignItems: "center",
    justifyContent: "center",
  },
  rowMain: { flex: 1, gap: 2 },
  rowHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowName: { color: "#e8f1ff", fontSize: 15, fontWeight: "600", flex: 1 },
  rowTimestamp: { color: "#7aa3d4", fontSize: 12 },
  rowTitle: { color: "#7aa3d4", fontSize: 12, marginTop: 2 },
  badge: {
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  badgePending: { backgroundColor: "#0e1c30", color: "#4d8fdb" },
  badgeFailed: { backgroundColor: "#2a1414", color: "#f87171" },

  detailScroll: { paddingBottom: 24 },
  detailHeader: { alignItems: "center", paddingVertical: 24, gap: 6 },
  kindAvatarLarge: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#11203a",
    alignItems: "center",
    justifyContent: "center",
  },
  detailName: { color: "#e8f1ff", fontSize: 20, fontWeight: "600" },
  detailTimestamp: { color: "#7aa3d4", fontSize: 13 },
  detailTitle: {
    color: "#7aa3d4",
    fontSize: 13,
    marginTop: 4,
    fontStyle: "italic",
  },

  section: { paddingHorizontal: 16, paddingTop: 16, gap: 8 },
  sectionLabel: {
    color: "#7aa3d4",
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  subtle: { color: "#7aa3d4", fontSize: 13, lineHeight: 18 },

  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },

  turnsList: { gap: 8, marginTop: 4 },
  turnRow: { flexDirection: "row" },
  turnRowLeft: { justifyContent: "flex-start" },
  turnRowRight: { justifyContent: "flex-end" },
  turnBubble: {
    maxWidth: "85%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
  },
  turnBubbleUser: { backgroundColor: "#3a5a8d" },
  turnBubbleAgent: { backgroundColor: "#11203a" },
  turnText: { fontSize: 14, lineHeight: 20 },
  turnTextUser: { color: "#e8f1ff" },
  turnTextAgent: { color: "#cdd9eb" },
});
