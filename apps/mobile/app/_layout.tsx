import {
  Sniglet_400Regular,
  Sniglet_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/sniglet';
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
  // Load Sniglet for the Audri wordmark. useFonts gates render until the
  // typeface is ready so we never see a fallback-flash. Once loaded, refer
  // to it in styles via fontFamily: 'Sniglet_800ExtraBold' (or _400Regular).
  const [fontsLoaded] = useFonts({
    Sniglet_400Regular,
    Sniglet_800ExtraBold,
  });

  if (!fontsLoaded) return null;

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
