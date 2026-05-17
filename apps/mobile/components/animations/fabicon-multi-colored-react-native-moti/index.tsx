// Multi-colored FAB animation. Originally from AnimateReactNative.com.
//
// Two named exports:
//
//   FabMenu  — just the satellite arc (no center button). Use this when
//              you need to pair the arc animation with a custom center
//              control. Open state is controlled by the caller via the
//              `isOpen` prop.
//
//   FabButton — FabMenu + a default circular center button with an X
//              icon that rotates between open / closed states. Manages
//              its own open state internally; matches the original
//              AnimateReactNative scaffold exactly.
//
// Default export remains the demo App from the original scaffold (uses
// FabButton with three menus). Helpful as a runnable reference when
// tweaking either exported component.
//
// Inspiration: https://dribbble.com/shots/17057599-Fashico-Mobile-Prototype-Animation

import { Feather } from '@expo/vector-icons';
import { type MotiTransition, MotiView } from 'moti';
import { MotiPressable } from 'moti/interactions';
import { type ReactNode, useMemo, useState } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';

// Snappy spring tuned for the FAB satellites — lower mass + higher
// stiffness than Moti's defaults so the entry/exit feels punchy
// (matches the AnimateReactNative demo's energy). Typed as the plain
// MotiTransition object — the function-form (per-interaction-state
// callback) isn't useful here since we drive isOpen externally.
const DEFAULT_TRANSITION: MotiTransition = {
  type: 'spring',
  damping: 12,
  mass: 0.6,
  stiffness: 220,
};

type FeatherIcon = keyof (typeof Feather)['glyphMap'];

export type FabMenuItem = {
  /** Stable React key per item. */
  key: string;
  /** Background color of the satellite circle. */
  color: string;
  /** Built-in Feather glyph. Ignored when `renderIcon` is provided. */
  icon?: FeatherIcon;
  /** Custom icon renderer — takes precedence over `icon`. Use when you
   *  need a glyph outside Feather's set (e.g. MaterialCommunityIcons
   *  "incognito" or lucide's `MessageCircle`). */
  renderIcon?: (iconSize: number, color: string) => ReactNode;
  /** Optional label rendered below the satellite when set. The label
   *  tracks the satellite's animated position so it stays anchored. */
  label?: string;
  /** Optional a11y label override; falls back to `label`. */
  accessibilityLabel?: string;
};

/** Args passed to a custom satellite surface renderer. Pre-resolves the
 *  icon node (using `renderIcon` / `icon` / fallback rules) so the
 *  consumer doesn't have to re-implement that logic. */
export interface FabSurfaceRenderProps {
  item: FabMenuItem;
  size: number;
  icon: ReactNode;
  onPress: () => void;
}

interface FabMenuPropsBase {
  menu: FabMenuItem[];
  /** Satellite circle diameter. Default 64. */
  size?: number;
  /** Offset from the anchor when closed — set > 0 to have satellites
   *  peek out slightly from behind the center. Default 4. */
  closedOffset?: number;
  /** Resting radius of the satellite arc (distance from anchor center
   *  to satellite center when open). Defaults to `size * 1.3`. Override
   *  for tighter or wider spreads. */
  radius?: number;
  /** Angular spread between adjacent satellites. Default π/3 (60°).
   *  Increase for wider fans (good for 2-item menus); decrease for
   *  tighter clusters. */
  offsetAngle?: number;
  /** Stagger delay per satellite in ms — index * staggerDelayMs
   *  determines each item's animation start. Default 100. */
  staggerDelayMs?: number;
  /** Override the default spring transition (object form only — see
   *  DEFAULT_TRANSITION). The per-item stagger delay is layered on
   *  top of this. */
  transition?: MotiTransition;
  onSelect: (selectedItem: FabMenuItem) => void;
  /** Optional custom button-surface renderer. When provided, replaces
   *  the default colored-circle Pressable for each satellite — useful
   *  for swapping in app-specific surfaces (e.g. GlassButton) while
   *  keeping the arc layout + spring animation. The wrapping MotiView
   *  still handles translate / opacity / scale. */
  renderButton?: (props: FabSurfaceRenderProps) => ReactNode;
}

export interface FabMenuProps extends FabMenuPropsBase {
  /** Controlled open state. Caller decides when the menu opens / closes.
   *  When this flips, the satellites spring to their new positions. */
  isOpen: boolean;
  /** Optional container style — useful when rendering inside a Modal
   *  where the consumer needs to position the menu anchor manually. */
  style?: StyleProp<ViewStyle>;
}

export function FabMenu({
  menu,
  size = 64,
  closedOffset = 4,
  radius,
  offsetAngle = Math.PI / 3,
  staggerDelayMs = 80,
  transition = DEFAULT_TRANSITION,
  onSelect,
  isOpen,
  style,
  renderButton,
}: FabMenuProps) {
  const iconSize = useMemo(() => size * 0.4, [size]);
  const _radius = radius ?? size * 1.3;
  return (
    <View style={style}>
      {menu.map((menuItem, index) => {
        // Reflected index centered on (n-1)/2 — handles both even and odd
        // menu counts symmetrically.
        //  2 items → [-0.5, 0.5]
        //  3 items → [-1, 0, 1]
        //  4 items → [-1.5, -0.5, 0.5, 1.5]
        // Multiply by `offsetAngle` to get each item's angle from vertical.
        const reflectedIndex = index - (menu.length - 1) / 2;
        const offset = isOpen ? _radius : closedOffset;
        const angle = reflectedIndex * offsetAngle;
        const translateX = Math.sin(angle) * offset;
        const translateY = -Math.cos(angle) * offset;
        return (
          <SatelliteItem
            key={menuItem.key}
            item={menuItem}
            size={size}
            iconSize={iconSize}
            isOpen={isOpen}
            translateX={translateX}
            translateY={translateY}
            transition={{
              ...transition,
              delay: (transition?.delay ?? 0) + index * staggerDelayMs,
            }}
            onPress={() => onSelect(menuItem)}
            renderButton={renderButton}
          />
        );
      })}
    </View>
  );
}

// Single satellite — extracted so consumers can re-implement the layout
// math (e.g. symmetric ±45° spread for a 2-item menu) while reusing the
// motion. Exported for advanced cases; FabMenu covers the common case.
//
// Animation lives on a wrapping MotiView; the button surface is a
// separate child. This split lets consumers swap the surface (via
// `renderButton`) for any pressable they want — GlassButton, a custom
// branded button, etc. — without losing the satellite arc spring.
interface SatelliteItemProps {
  item: FabMenuItem;
  size: number;
  iconSize: number;
  isOpen: boolean;
  translateX: number;
  translateY: number;
  /** Full Moti transition (spring params + per-item delay). Defaults
   *  to the snappy spring tuned for this component. */
  transition?: MotiTransition;
  onPress: () => void;
  /** Optional custom surface renderer. See FabSurfaceRenderProps. When
   *  omitted, defaults to a solid-color circle Pressable. */
  renderButton?: (props: FabSurfaceRenderProps) => ReactNode;
}

export function SatelliteItem({
  item,
  size,
  iconSize,
  isOpen,
  translateX,
  translateY,
  transition = DEFAULT_TRANSITION,
  onPress,
  renderButton,
}: SatelliteItemProps) {
  const icon = item.renderIcon ? (
    item.renderIcon(iconSize, '#fff')
  ) : item.icon ? (
    <Feather name={item.icon} size={iconSize} color={'#fff'} />
  ) : null;
  const surface = renderButton ? (
    renderButton({ item, size, icon, onPress })
  ) : (
    <Pressable
      onPress={onPress}
      accessibilityLabel={item.accessibilityLabel ?? item.label}
      style={[
        styles.circle,
        { backgroundColor: item.color },
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      {icon}
    </Pressable>
  );
  return (
    <MotiView
      animate={{
        translateX,
        translateY,
        opacity: isOpen ? 1 : 0,
        scale: isOpen ? 1 : 0.5,
      }}
      style={[{ position: 'absolute' }, { width: size, height: size }]}
      transition={transition}
    >
      {surface}
      {item.label ? (
        <View style={[styles.labelHost, { top: size + 6, width: size }]}>
          <Text style={styles.label} numberOfLines={1}>
            {item.label}
          </Text>
        </View>
      ) : null}
    </MotiView>
  );
}

////////////////////
///////////// API //
////////////////////

export type FabButtonProps = FabMenuPropsBase & {
  /** Optional initial open state (uncontrolled). Defaults to closed. */
  defaultOpen?: boolean;
};

export function FabButton({
  menu,
  size = 64,
  closedOffset = 4,
  onSelect,
  defaultOpen = false,
}: FabButtonProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const iconSize = useMemo(() => size * 0.4, [size]);
  return (
    <View>
      <View style={{ position: 'absolute' }}>
        <FabMenu
          menu={menu}
          size={size}
          closedOffset={closedOffset}
          isOpen={isOpen}
          onSelect={(item) => {
            setIsOpen((prev) => !prev);
            onSelect(item);
          }}
        />
      </View>
      <MotiPressable
        onPress={() => {
          setIsOpen((prev) => !prev);
        }}
        style={[
          styles.circle,
          { backgroundColor: _colors.gray },
          { width: size, height: size, borderRadius: size / 2 },
        ]}
        animate={{
          rotate: isOpen ? '0deg' : '-45deg',
        }}
      >
        <Feather name="x" size={iconSize} color={'#fff'} />
      </MotiPressable>
    </View>
  );
}

const _colors = {
  gray: '#1D1520',
  white: '#f3f3f3',
};

const styles = StyleSheet.create({
  circle: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  labelHost: {
    position: 'absolute',
    alignItems: 'center',
  },
  label: {
    color: '#e8f1ff',
    fontSize: 12,
    letterSpacing: 0.5,
  },
});
