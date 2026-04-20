import React, { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useGeminiLive } from "../hooks/useGeminiLive";
import { GlassView } from "expo-glass-effect";
import { PhoneCall } from "lucide-react-native";
import { formatHex } from "culori";

type Props = { onExit: () => void };

export function VoiceScreen({ onExit }: Props) {
  const { connect, disconnect, isConnected, isModelSpeaking } = useGeminiLive();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, []);

  const status = !isConnected
    ? "Connecting…"
    : isModelSpeaking
      ? "Speaking…"
      : "Listening…";

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}>
        <View
          style={[
            styles.orb,
            isConnected && styles.orbConnected,
            isModelSpeaking && styles.orbSpeaking,
          ]}
        />
        <Text style={styles.statusText}>{status}</Text>
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
  exitButton: {
    alignSelf: "flex-end",
    margin: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#444",
  },
  exitText: {
    color: "#aaa",
    fontSize: 14,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
  },
  orb: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "#1a1a2e",
    borderWidth: 2,
    borderColor: "#333",
  },
  orbConnected: {
    borderColor: "#4a9eff",
  },
  orbSpeaking: {
    backgroundColor: "#16213e",
    borderColor: "#a78bfa",
  },
  statusText: {
    color: "#ccc",
    fontSize: 18,
    fontWeight: "300",
    letterSpacing: 0.5,
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
