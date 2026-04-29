import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ProfileOverlay } from '../components/ProfileOverlay';
import { ResearchOverlay } from '../components/ResearchOverlay';
import { TodosOverlay } from '../components/TodosOverlay';
import { WikiOverlay } from '../components/WikiOverlay';
import { Sentry, initSentry } from '../lib/sentry';
import '../global.css';

// Init Sentry as early as possible at module load so any error during the
// React render path is captured. DSN-gated so local dev w/o EXPO_PUBLIC_SENTRY_DSN
// is a quiet no-op.
initSentry();

function RootLayout() {
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
      <ProfileOverlay />
      <TodosOverlay />
    </SafeAreaProvider>
  );
}

// Wraps the root with Sentry's error boundary so render-path exceptions get
// captured along with component-stack info. Shows the default fallback (a
// blank screen) on crash; we'll polish this later if it ever fires in prod.
export default Sentry.wrap(RootLayout);
