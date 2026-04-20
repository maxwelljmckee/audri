import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { HomeScreen } from "./src/screens/HomeScreen";
import { VoiceScreen } from "./src/screens/VoiceScreen";
import * as Haptics from "expo-haptics";
import "./src/nativewind/global.css";

type Screen = "home" | "voice";

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {screen === "home" ? (
        <HomeScreen
          onGoLive={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setScreen("voice");
          }}
        />
      ) : (
        <VoiceScreen
          onExit={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setScreen("home");
          }}
        />
      )}
    </SafeAreaProvider>
  );
}
