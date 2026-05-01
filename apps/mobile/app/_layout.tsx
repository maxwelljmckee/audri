import { Comfortaa_400Regular, useFonts } from '@expo-google-fonts/comfortaa';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
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
  // Load Comfortaa for the Audri wordmark. useFonts gates render until the
  // typeface is ready so we never see a fallback-flash. Reference in styles
  // via fontFamily: 'Comfortaa_400Regular'.
  const [fontsLoaded] = useFonts({ Comfortaa_400Regular });

  if (!fontsLoaded) return null;

  return (
    // App-wide backdrop — visible only when a stack-nav or overlay
    // transition exposes the gap behind/between screens. Each screen still
    // owns its opaque background; the backdrop is the floor everything
    // paints over. Token-wrapped (`--color-app-backdrop`) so the eventual
    // swap to gradient or lavalamp is a single CSS change.
    <View className="flex-1 bg-app-backdrop">
      <SafeAreaProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            // Transparent stack content so the backdrop shows through
            // during route transitions — otherwise native-stack paints a
            // white card behind transitioning screens on iOS.
            contentStyle: { backgroundColor: 'transparent' },
          }}
        >
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
    </View>
  );
}

// Wraps the root with Sentry's error boundary so render-path exceptions get
// captured along with component-stack info. Shows the default fallback (a
// blank screen) on crash; we'll polish this later if it ever fires in prod.
export default Sentry.wrap(RootLayout);
