import React, { useRef } from "react";
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import bgStars from "../assets/images/bg-stars.png";
import { GlassView } from "expo-glass-effect";
import { Phone } from "lucide-react-native";
import { formatHex } from "culori";
import { Notebook, Plus, Bot } from "lucide-react-native";
import Fontisto from "@expo/vector-icons/Fontisto";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import {
  PluginOverlay,
  PluginScreenProps,
  usePluginOverlay,
} from "../components/PluginOverlay";
import { ActivityScreen } from "./plugins/ActivityScreen";
import { NotesScreen } from "./plugins/NotesScreen";
import { PodcastsScreen } from "./plugins/PodcastsScreen";
import { GraphScreen } from "./plugins/GraphScreen";

const iconColor = formatHex({ mode: "oklch", l: 0.705, c: 0.015, h: 286.067 });

const NUM_COLS = 4;
const SCREEN_PADDING = 16;
const TILE_GAP = 12;

type Plugin = {
  id: string;
  label?: string;
  icon: React.ReactNode;
  component?: React.ComponentType<PluginScreenProps>;
};

type Props = { onGoLive: () => void };

const PLUGINS: Plugin[] = [
  {
    id: "agents",
    label: "Agents",
    icon: <Bot size={40} color={iconColor} strokeWidth={1.8} />,
    // component: AgentsScreen,
  },
  {
    id: "activity",
    label: "Activity",
    icon: (
      <MaterialCommunityIcons
        name="format-list-bulleted-type"
        size={40}
        color={iconColor}
      />
    ),
    component: ActivityScreen,
  },
  {
    id: "notes",
    label: "Notes",
    icon: <Notebook size={40} color={iconColor} strokeWidth={1.8} />,
    component: NotesScreen,
  },
  {
    id: "podcasts",
    label: "Podcasts",
    icon: <Fontisto name="podcast" size={40} color={iconColor} />,
    component: PodcastsScreen,
  },
  {
    id: "graph",
    label: "Graph",
    icon: <Fontisto name="graphql" size={40} color={iconColor} />,
    component: GraphScreen,
  },
  {
    id: "add",
    icon: <Plus size={50} color={iconColor} />,
  },
];

export function HomeScreen({ onGoLive }: Props) {
  const { width } = useWindowDimensions();
  const tileSize =
    (width - SCREEN_PADDING * 2 - TILE_GAP * (NUM_COLS - 1)) / NUM_COLS;

  const { launch, close, overlay, animValue } = usePluginOverlay();
  const pressableRefs = useRef<(React.ComponentRef<typeof Pressable> | null)[]>(
    [],
  );

  return (
    <View style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }}>
        <Image
          source={bgStars}
          className="absolute inset-0 h-screen w-screen resize-cover"
        />
        <View
          className="absolute inset-0 h-screen w-screen"
          style={{
            backgroundColor: formatHex({
              mode: "oklch",
              l: 0.13,
              c: 0.028,
              h: 261.692,
            }),
            opacity: 0.6,
          }}
        />

        <View className="h-full w-full flex p-4">
          <View className="flex-1">
            <Text className="text-slate-50 text-3xl font-semibold mb-4">
              Core Plugins
            </Text>
            <FlatList
              data={PLUGINS}
              numColumns={NUM_COLS}
              keyExtractor={(item) => item.id}
              columnWrapperStyle={{ gap: TILE_GAP }}
              ItemSeparatorComponent={() => (
                <View style={{ height: TILE_GAP }} />
              )}
              renderItem={({ item, index }) => (
                <Pressable
                  ref={(el) => {
                    pressableRefs.current[index] = el;
                  }}
                  onPress={() => {
                    const ref = pressableRefs.current[index];
                    if (item.component && ref) launch(item.component, ref);
                  }}
                  style={{ width: tileSize, height: tileSize }}
                >
                  <GlassView style={styles.pluginItem} glassEffectStyle="clear">
                    {item.icon}
                    {item.label && (
                      <Text className="text-zinc-400 mt-1 font-bold">
                        {item.label}
                      </Text>
                    )}
                  </GlassView>
                </Pressable>
              )}
            />
          </View>

          <Pressable onPress={onGoLive}>
            <GlassView style={styles.glassView} glassEffectStyle="clear">
              <Phone size={42} strokeWidth={2.5} color={iconColor} />
            </GlassView>
          </Pressable>
        </View>
      </SafeAreaView>

      <PluginOverlay overlay={overlay} animValue={animValue} onClose={close} />
    </View>
  );
}

const buttonSize = 80;

const styles = StyleSheet.create({
  overlay: {
    backgroundColor: "rgba(0, 0, 0, 0.6)",
  },
  pluginItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
  },
  glassView: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    height: buttonSize,
    width: buttonSize,
    borderRadius: buttonSize / 2,
    opacity: 0.8,
  },
});
