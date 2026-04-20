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
import { PhoneCall } from "lucide-react-native";
import { formatHex } from "culori";
import { Notebook, Plus, Bot, User } from "lucide-react-native";
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
import * as Haptics from "expo-haptics";

const iconColor = formatHex({ mode: "oklch", l: 0.92, c: 0.004, h: 286.32 });

const NUM_COLS = 4;
const SCREEN_PADDING = 16;
const TILE_GAP = 20;

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
    id: "me",
    label: "Me",
    icon: <User size={40} color={iconColor} />,
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
    <View className="flex-1">
      <SafeAreaView className="flex-1">
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
                <View className="flex flex-col items-center justify-start my-2">
                  <Pressable
                    ref={(el) => {
                      pressableRefs.current[index] = el;
                    }}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      const ref = pressableRefs.current[index];
                      if (item.component && ref) launch(item.component, ref);
                    }}
                    style={{ width: tileSize, height: tileSize }}
                  >
                    <GlassView
                      style={styles.pluginItem}
                      glassEffectStyle="clear"
                    >
                      {item.icon}
                    </GlassView>
                  </Pressable>
                  {item.label && (
                    <Text className="text-zinc-200 mt-1 font-bold">
                      {item.label}
                    </Text>
                  )}
                </View>
              )}
            />
          </View>

          <Pressable onPress={onGoLive}>
            <View className="bg-emerald-500/40" style={styles.glassView}>
              <GlassView style={styles.glassViewInner} glassEffectStyle="clear">
                <PhoneCall size={42} strokeWidth={2.5} style={{ opacity: 1 }} />
              </GlassView>
            </View>
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
  },
  glassViewInner: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: buttonSize,
    width: buttonSize,
    borderRadius: buttonSize / 2,
  },
});
