// Home-screen primary FAB. Tap = start a voice call. Long-press = reveal
// two satellite options (Incognito + Chat) in an arc above the button.
//
// Satellite arc + animation come straight from the AnimateReactNative
// FabMenu component (see components/animations/fabicon-multi-colored-
// react-native-moti). We just provide the menu items + control the
// `isOpen` flag externally so:
//   - long-press on the CallButton opens it
//   - tapping the backdrop / satellite closes it
//   - the close animation has time to play before the Modal unmounts
//
// While a call/chat is active, long-press is disabled and tapping
// returns to the in-progress session.

import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { MessageCircle } from 'lucide-react-native';
import { MotiView } from 'moti';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FabMenu, type FabMenuItem } from '../animations/fabicon-multi-colored-react-native-moti';
import { CallButton } from './CallButton';
import { GlassButton } from './GlassButton';

const BUTTON_SIZE = 80;
const SATELLITE_SIZE = 64;
// Resting distance from the FAB center to each satellite center when
// the menu is open. Larger than FabMenu's default `size * 1.3` so the
// satellites clear the bigger CallButton with room to breathe.
const SATELLITE_RADIUS = 120;
// Angular spread between adjacent satellites. With 2 items, the
// reflectedIndex math (centered on 0) puts them at ±offsetAngle/2 —
// so π/2 = 90° total spread = ±45° from vertical. Symmetric arc, both
// satellites clearly above the horizon line of the center.
const SATELLITE_OFFSET_ANGLE = Math.PI / 3;
// Satellites peek out of the center button when closed so there's a
// visible hint that more options live behind it (matches the scaffold's
// default 4px).
const SATELLITE_CLOSED_OFFSET = 6;
// Vertical anchor: same y as the call button's center on the home
// screen. Mirrors home/_layout's fabRow: paddingBottom: 16 + helper-text
// line (~18) + gap (8) + button half-height (40). Used in Modal coords
// where the SafeAreaView's bottom inset still applies (pulled from the
// hook below).
const BUTTON_CENTER_FROM_FABROW_BOTTOM = 16 + 18 + 8 + BUTTON_SIZE / 2;

const INCOGNITO_TINT = '#3f3f4a';
const CHAT_TINT = '#10b981'; // emerald-500 — matches CallButton 'start'

const ACTIVE_TINT = '#10b981';
const OPEN_TINT = '#1f1f24'; // dim the center while satellites are foregrounded

const MENU_ITEMS: FabMenuItem[] = [
  {
    key: 'incognito',
    color: INCOGNITO_TINT,
    label: 'Incognito',
    accessibilityLabel: 'Start incognito call — nothing is saved',
    renderIcon: (size, color) => (
      <MaterialCommunityIcons name="incognito" size={size} color={color} />
    ),
  },
  {
    key: 'chat',
    color: CHAT_TINT,
    label: 'Chat',
    accessibilityLabel: 'Start text chat',
    renderIcon: (size, color) => <MessageCircle size={size} color={color} strokeWidth={2} />,
  },
];

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

  // isOpen drives FabMenu's `animate` — flipping it kicks the spring
  // transition in either direction. menuMounted controls Modal
  // visibility separately so the close animation has time to play
  // before the Modal unmounts (Modal unmount = instant cut otherwise).
  const [isOpen, setIsOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);

  function openMenu() {
    if (active) return;
    setMenuMounted(true);
    // Defer the open flag one tick so satellites have a chance to mount
    // at their closed-state positions; otherwise they appear already
    // mid-animation and the spring lands without an entry feel.
    requestAnimationFrame(() => setIsOpen(true));
  }
  function closeMenu() {
    setIsOpen(false);
    // Keep the Modal mounted for the spring settle time so the close
    // animation plays. ~400ms covers a default moti spring comfortably.
    setTimeout(() => setMenuMounted(false), 400);
  }

  function handleCenterPress() {
    if (active) {
      onRejoin();
      return;
    }
    if (menuMounted) {
      closeMenu();
      return;
    }
    onStartCall();
  }

  function handleSelect(item: FabMenuItem) {
    closeMenu();
    if (item.key === 'incognito') onStartIncognito();
    else if (item.key === 'chat') onStartChat();
  }

  // Anchor position for the satellite container (Modal coords =
  // screen coords). Wraps a single-satellite-sized box at the FAB
  // center; FabMenu translates its satellites outward from there.
  const anchorBottom = insets.bottom + BUTTON_CENTER_FROM_FABROW_BOTTOM;
  const anchorLeft = screenWidth / 2;

  return (
    <>
      <View style={styles.root}>
        <CallButton
          mode="start"
          onPress={handleCenterPress}
          onLongPress={openMenu}
          // CallButton stays on its natural emerald tint; the
          // open-state darkening is driven by an animated MotiView
          // overlay below so the color transition is springy instead
          // of an instant tint swap.
          tintColor={ACTIVE_TINT}
          accessibilityLabel={
            active
              ? 'Return to call in progress'
              : menuMounted
                ? 'Close menu'
                : 'Start call. Hold for more options.'
          }
        >
          {/* Animated dark tint overlay — fully covers the emerald glass
              when the menu opens (opacity → 1) so the close-state matches
              the original pure-dark close button look, then fades back
              out on close. Matches the icon crossfade + satellite arc
              spring so the entire open/close motion reads as one
              coordinated transition. */}
          <MotiView
            animate={{ opacity: isOpen ? 1 : 0 }}
            transition={{ type: 'spring', damping: 14, mass: 0.5, stiffness: 220 }}
            style={styles.centerTintOverlay}
            pointerEvents="none"
          />
          {active ? (
            <Ionicons name="arrow-forward" size={28} color="#ffffff" />
          ) : (
            <CenterIconCrossfade menuOpen={isOpen} />
          )}
        </CallButton>
        {/* Helper text fades out when the menu opens — the satellite
            labels carry the user-facing hint at that point. Always
            reserves its layout space (opacity-only) so the FAB doesn't
            shift vertically when the menu toggles. */}
        <MotiView
          animate={{ opacity: isOpen ? 0 : 1 }}
          transition={{ type: 'timing', duration: 220 }}
        >
          <Text style={styles.helper} numberOfLines={1}>
            {active ? (helperLabel ?? 'Call in progress') : 'Hold for More'}
          </Text>
        </MotiView>
      </View>

      <Modal
        visible={menuMounted}
        transparent
        animationType="none"
        onRequestClose={closeMenu}
        statusBarTranslucent
      >
        {/* Backdrop fade: MotiView drives opacity from 0 → 1 on open,
            1 → 0 on close. The Modal stays mounted during the close
            spring (handled by the menuMounted setTimeout) so the
            backdrop has time to fade out before unmount. */}
        <MotiView
          from={{ opacity: 0 }}
          animate={{ opacity: isOpen ? 1 : 0 }}
          transition={{ type: 'timing', duration: 220 }}
          style={StyleSheet.absoluteFill}
        >
          <Pressable style={styles.backdrop} onPress={closeMenu}>
            <FabMenu
              menu={MENU_ITEMS}
              size={SATELLITE_SIZE}
              radius={SATELLITE_RADIUS}
              offsetAngle={SATELLITE_OFFSET_ANGLE}
              closedOffset={SATELLITE_CLOSED_OFFSET}
              isOpen={isOpen}
              onSelect={handleSelect}
              style={[
                styles.anchor,
                {
                  bottom: anchorBottom - SATELLITE_SIZE / 2,
                  left: anchorLeft - SATELLITE_SIZE / 2,
                },
              ]}
              // GlassButton satellites match the center FAB's surface
              // language — Liquid Glass on iOS 26+, BlurView elsewhere.
              // Per-item `color` flows through as the tint so each
              // satellite still reads as its menu role (Incognito dim,
              // Chat emerald) while sharing the glass treatment.
              renderButton={({ item, size, icon, onPress }) => (
                <GlassButton
                  onPress={onPress}
                  tintColor={item.color}
                  accessibilityLabel={item.accessibilityLabel ?? item.label}
                  style={{ width: size, height: size, borderRadius: size / 2 }}
                >
                  {icon}
                </GlassButton>
              )}
            />
          </Pressable>
        </MotiView>
      </Modal>
    </>
  );
}

// Cross-fade between the phone (closed) and X (open) icons. Both are
// rendered at the center; opposite opacities + a small scale dip on the
// outgoing icon makes the swap feel like a transition rather than a
// hard cut. Spring transition matches the satellite arc for a unified
// feel across the entire open/close motion.
function CenterIconCrossfade({ menuOpen }: { menuOpen: boolean }) {
  return (
    <View style={styles.centerIconHost}>
      <MotiView
        animate={{ opacity: menuOpen ? 0 : 1, scale: menuOpen ? 0.6 : 1 }}
        transition={{ type: 'spring', damping: 14, mass: 0.5, stiffness: 220 }}
        style={styles.centerIconLayer}
      >
        <Ionicons name="call" size={32} color="#ffffff" />
      </MotiView>
      <MotiView
        animate={{ opacity: menuOpen ? 1 : 0, scale: menuOpen ? 1 : 0.6 }}
        transition={{ type: 'spring', damping: 14, mass: 0.5, stiffness: 220 }}
        style={styles.centerIconLayer}
      >
        <Ionicons name="close" size={32} color="#ffffff" />
      </MotiView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    gap: 8,
  },
  centerIconHost: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Animated dark overlay layered inside CallButton — borderRadius
  // matches the button's circle so the tint doesn't leak past the
  // glass surface's bounds.
  centerTintOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: OPEN_TINT,
    borderRadius: BUTTON_SIZE / 2,
  },
  centerIconLayer: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
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
});
