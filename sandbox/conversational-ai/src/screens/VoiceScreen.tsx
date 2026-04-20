import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useGeminiLive } from "../hooks/useGeminiLive";
import { GlassView } from "expo-glass-effect";
import { PhoneCall } from "lucide-react-native";

type Props = { onExit: () => void };

const ORB_COLORS = {
  border: ["#3b82f6", "#6366f1"],
  bg: ["#1e3a5f", "#1e1b4b"],
};

export function VoiceScreen({ onExit }: Props) {
  const { connect, disconnect, isConnected, isModelSpeaking } = useGeminiLive();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, []);

  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const callTime = `${minutes}:${String(seconds).padStart(2, "0")}`;

  const orbState = isModelSpeaking ? 1 : 0;
  const animValue = useSharedValue(0);

  useEffect(() => {
    animValue.value = withTiming(orbState, { duration: 400 });
  }, [orbState]);

  const animatedOrbStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(animValue.value, [0, 1], ORB_COLORS.border),
    backgroundColor: interpolateColor(animValue.value, [0, 1], ORB_COLORS.bg),
  }));

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}>
        <Text className="text-zinc-200 text-[32px] font-semibold">
          {callTime}
        </Text>
        <Animated.View style={[styles.orb, animatedOrbStyle]} />
      </View>

      <Pressable onPress={onExit}>
        <View className="bg-rose-500/40" style={styles.glassView}>
          <GlassView style={styles.glassViewInner} glassEffectStyle="clear">
            <View style={{ transform: [{ rotate: "270deg" }] }}>
              <PhoneCall size={42} strokeWidth={2.5} />
            </View>
          </GlassView>
        </View>
      </Pressable>
    </SafeAreaView>
  );
}

const buttonSize = 80;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0d0d0d",
    alignItems: "center",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
  },
  orb: {
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 2,
  },
  callTime: {
    color: "#ccc",
    fontSize: 18,
    fontWeight: "300",
    letterSpacing: 1,
    fontVariant: ["tabular-nums"],
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
    opacity: 0.8,
  },
});
