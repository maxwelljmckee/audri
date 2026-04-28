// Per-plugin stack navigator. Each plugin overlay (Wiki, Research, …) mounts
// one of these inside its scale-from-tile shell. Gives us real push/pop
// semantics, slide-in/out transitions, native back gesture, and per-screen
// header management — replacing the "single view + setView state" pattern
// the overlays used to use.
//
// The stack is INDEPENDENT (not nested inside Expo Router's stack) — the
// overlay floats outside the router tree. This is fine; React Navigation
// supports independent containers and our overlay is a self-contained
// floating surface.
//
// Usage:
//   const Stack = createPluginStack<{ Folders: undefined; Page: { id: string } }>();
//   <PluginNavigationContainer>
//     <Stack.Navigator screenOptions={pluginStackScreenOptions}>
//       <Stack.Screen name="Folders" component={FoldersScreen} />
//       <Stack.Screen name="Page" component={PageScreen} />
//     </Stack.Navigator>
//   </PluginNavigationContainer>

import { Ionicons } from '@expo/vector-icons';
import { NavigationContainer, NavigationIndependentTree } from '@react-navigation/native';
import {
  type NativeStackNavigationOptions,
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import type { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// Reuse the same Stack constructor across all plugins; each plugin parameterizes
// its own ParamList via createPluginStack<T>().
export function createPluginStack<
  // biome-ignore lint/suspicious/noExplicitAny: passthrough generic for ParamList
  ParamList extends Record<string, any>,
>() {
  return createNativeStackNavigator<ParamList>();
}

// Default screen options shared across all plugin stacks. Header is hidden
// because each plugin's PluginOverlay shell already owns the title chrome
// (the close button, animated title), and screens use a custom inline header
// row for the back chevron + section label.
export const pluginStackScreenOptions: NativeStackNavigationOptions = {
  headerShown: false,
  contentStyle: { backgroundColor: '#0a1628' },
  animation: 'slide_from_right',
  gestureEnabled: true,
  fullScreenGestureEnabled: true,
};

// Wraps the plugin stack in its own NavigationContainer that's explicitly
// marked as an independent tree — the outer Expo Router has its own
// container, and v7 requires NavigationIndependentTree to opt into a nested
// container without warnings. Each plugin overlay floats outside the router
// tree, so independent is what we want.
export function PluginNavigationContainer({ children }: PropsWithChildren) {
  return (
    <NavigationIndependentTree>
      <NavigationContainer>
        <View style={styles.flex}>{children}</View>
      </NavigationContainer>
    </NavigationIndependentTree>
  );
}

// Standard back-row chrome used by every secondary screen in a plugin stack.
// Renders a chevron + label that pops the stack when tapped.
export function PluginBackRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.backRow} onPress={onPress} hitSlop={8}>
      <Ionicons name="chevron-back" size={20} color="#7aa3d4" />
      <Text style={styles.backLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  backLabel: { color: '#7aa3d4', fontSize: 15 },
});
