// Home-screen primary FAB. Tap = start a voice call. Long-press = reveal
// two satellite options (Incognito + Chat) in an arc above the button.
//
// While a call is active, long-press is disabled and tapping returns to the
// in-progress session — matches the existing "rejoin" affordance.
//
// Satellites + backdrop render inside a transparent Modal so they sit on top
// of the home grid + helper text. Tapping the backdrop closes the menu;
// tapping a satellite closes + routes.

import { Ionicons } from '@expo/vector-icons';
import { MessageCircle } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CallButton } from './CallButton';
import { GlassButton } from './GlassButton';

const BUTTON_SIZE = 80;
const SATELLITE_SIZE = 60;
const SATELLITE_RADIUS = 110;
// Vertical anchor: same y as the call button's center on the home screen.
// Mirrors home/_layout's fabRow: paddingBottom: 16 + helper-text line (~18)
// + gap (8) + button half-height (40). Used in Modal coords where the
// SafeAreaView's bottom inset still applies (we pull that from the hook).
const BUTTON_CENTER_FROM_FABROW_BOTTOM = 16 + 18 + 8 + BUTTON_SIZE / 2;

const SATELLITE_TINTS = {
  incognito: '#3f3f4a',
  chat: '#3b82f6',
} as const;

const ACTIVE_TINT = '#10b981'; // emerald-500 — matches CallButton 'start'
const OPEN_TINT = '#1f1f24'; // dim the center while satellites are foregrounded

export interface CallFabProps {
  /** True when a call/chat session is alive in the background (rejoin
   *  state). Disables long-press and swaps the icon to a "return to
   *  session" affordance. */
  active: boolean;
  onStartCall: () => void;
  onStartIncognito: () => void;
  onStartChat: () => void;
  onRejoin: () => void;
  helperLabel?: string;
}

export function CallFab({
  active,
  onStartCall,
  onStartIncognito,
  onStartChat,
  onRejoin,
  helperLabel,
}: CallFabProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const open = useSharedValue(0);

  // React-side open flag — drives Modal visibility. The shared value
  // `open` is the animation driver; this state controls mount/unmount of
  // the Modal so satellites can't steal touches while invisible.
  const [menuOpen, setMenuOpen] = useState(false);

  function openMenu() {
    if (active) return;
    setMenuOpen(true);
    open.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) });
  }
  function closeMenu() {
    open.value = withTiming(0, { duration: 180, easing: Easing.in(Easing.cubic) });
    setMenuOpen(false);
  }

  function handleCenterPress() {
    if (active) {
      onRejoin();
      return;
    }
    if (menuOpen) {
      closeMenu();
      return;
    }
    onStartCall();
  }

  function handleSatellite(action: 'incognito' | 'chat') {
    closeMenu();
    if (action === 'incognito') onStartIncognito();
    else onStartChat();
  }

  // Animated styles for the two satellites. Both fade + scale in from the
  // center button; translate outward to their resting position at ±45° above
  // vertical.
  const angleLeft = -Math.PI / 4; // upper-left
  const angleRight = Math.PI / 4; // upper-right

  const incognitoStyle = useAnimatedStyle(() => ({
    opacity: open.value,
    transform: [
      { translateX: Math.sin(angleLeft) * SATELLITE_RADIUS * open.value },
      { translateY: -Math.cos(angleLeft) * SATELLITE_RADIUS * open.value },
      { scale: interpolate(open.value, [0, 1], [0.4, 1]) },
    ],
  }));
  const chatStyle = useAnimatedStyle(() => ({
    opacity: open.value,
    transform: [
      { translateX: Math.sin(angleRight) * SATELLITE_RADIUS * open.value },
      { translateY: -Math.cos(angleRight) * SATELLITE_RADIUS * open.value },
      { scale: interpolate(open.value, [0, 1], [0.4, 1]) },
    ],
  }));

  // Bottom anchor matches the call button's center y in the home screen.
  const anchorBottom = insets.bottom + BUTTON_CENTER_FROM_FABROW_BOTTOM;
  const anchorLeft = screenWidth / 2;

  return (
    <>
      <View style={styles.root}>
        <CallButton
          mode="start"
          onPress={handleCenterPress}
          onLongPress={openMenu}
          tintColor={menuOpen ? OPEN_TINT : ACTIVE_TINT}
          accessibilityLabel={
            active
              ? 'Return to call in progress'
              : menuOpen
                ? 'Close menu'
                : 'Start call. Hold for more options.'
          }
        >
          {active ? (
            <Ionicons name="arrow-forward" size={28} color="#ffffff" />
          ) : menuOpen ? (
            <Ionicons name="close" size={32} color="#ffffff" />
          ) : undefined}
        </CallButton>
        {/* Helper text always rendered (with a single-space fallback when
            the menu is open) so the FAB's y position is stable across
            state changes. */}
        <Text style={styles.helper} numberOfLines={1}>
          {active ? (helperLabel ?? 'Call in progress') : menuOpen ? ' ' : 'Hold for More'}
        </Text>
      </View>

      <Modal
        visible={menuOpen}
        transparent
        animationType="none"
        onRequestClose={closeMenu}
        statusBarTranslucent
      >
        <Pressable style={styles.backdrop} onPress={closeMenu}>
          {/* Anchor positioned at the FAB's center. Satellites translate
              outward from this point. */}
          <View
            pointerEvents="box-none"
            style={[
              styles.anchor,
              { bottom: anchorBottom - SATELLITE_SIZE / 2, left: anchorLeft - SATELLITE_SIZE / 2 },
            ]}
          >
            <Animated.View style={[styles.satelliteWrap, incognitoStyle]}>
              <GlassButton
                onPress={() => handleSatellite('incognito')}
                tintColor={SATELLITE_TINTS.incognito}
                accessibilityLabel="Start incognito call — nothing is saved"
                accessibilityRole="button"
                style={styles.satellite}
              >
                <Ionicons name="glasses-outline" size={26} color="#ffffff" />
              </GlassButton>
              <Text style={styles.satelliteLabel}>Incognito</Text>
            </Animated.View>
            <Animated.View style={[styles.satelliteWrap, chatStyle]}>
              <GlassButton
                onPress={() => handleSatellite('chat')}
                tintColor={SATELLITE_TINTS.chat}
                accessibilityLabel="Start text chat"
                accessibilityRole="button"
                style={styles.satellite}
              >
                <MessageCircle size={26} color="#ffffff" strokeWidth={2} />
              </GlassButton>
              <Text style={styles.satelliteLabel}>Chat</Text>
            </Animated.View>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    gap: 8,
  },
  helper: {
    color: '#7aa3d4',
    fontSize: 13,
    letterSpacing: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(8, 12, 24, 0.45)',
  },
  anchor: {
    position: 'absolute',
    width: SATELLITE_SIZE,
    height: SATELLITE_SIZE,
  },
  satelliteWrap: {
    position: 'absolute',
    width: SATELLITE_SIZE,
    height: SATELLITE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  satellite: {
    width: SATELLITE_SIZE,
    height: SATELLITE_SIZE,
    borderRadius: SATELLITE_SIZE / 2,
  },
  satelliteLabel: {
    position: 'absolute',
    top: SATELLITE_SIZE + 6,
    color: '#e8f1ff',
    fontSize: 12,
    letterSpacing: 0.5,
  },
});
