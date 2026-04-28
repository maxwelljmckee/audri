import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ResearchOverlay } from '../components/ResearchOverlay';
import { WikiOverlay } from '../components/WikiOverlay';
import '../global.css';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
      </Stack>
      <StatusBar style="light" />
      {/* Plugin overlays mount at app root so navigation away (e.g., to /call)
          doesn't tear them down. Each handles its own visibility via the
          plugin-overlay store. */}
      <WikiOverlay />
      <ResearchOverlay />
    </SafeAreaProvider>
  );
}
